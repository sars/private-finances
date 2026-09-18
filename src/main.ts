import { LLM_OUTPUT_TOKEN_LIMIT } from './llm-budget.js';
import { loadEnableBankingCredentials } from './enablebanking-credentials.js';
import { credentialsHealthFromEnv } from './credential-health.js';
import { loadFeedCredentials } from './holding-fill.js';
import { memoryDatabase, postgresDatabase, migrate } from './database.js';
import { Repository } from './repository.js';
import { web } from './web.js';
import { synthetic } from './synthetic.js';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TelegramClarifications, telegramTransport } from './telegram.js';
import { Classifier } from './classifier.js';
import {
  Categories,
  assignablePaths,
  ensureStarterCategories,
} from './categories.js';
import { ConsentService } from './consent.js';
import { forgetExpiredSessions, seedOwners } from './auth.js';

/**
 * When the newest local database snapshot was taken.
 *
 * `deploy/local-backup.py` names each dump after the nanosecond it finished, so
 * the filename is the timestamp and no file needs opening — which matters,
 * because the application must never be able to read the dumps themselves. A
 * directory it cannot list at all is reported as "no backup", the same as an
 * empty one: both mean the same thing to somebody who has to fix it.
 */
async function newestBackupAt(directory: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  const newest = names
    .filter((name) => /^\d+\.dump$/.test(name))
    .map((name) => Number(name.slice(0, -5)) / 1e6)
    .filter((millis) => Number.isFinite(millis) && millis > 0)
    .sort((a, b) => a - b)
    .at(-1);
  return newest === undefined ? null : new Date(newest).toISOString();
}

const mode = process.env.APP_MODE ?? 'demo';
if (mode !== 'demo' && mode !== 'postgres')
  throw new Error('APP_MODE must be demo or postgres');
const port = Number(process.env.PORT ?? 3300);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PORT');
if (mode === 'postgres' && !process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required');
if (mode === 'demo') await mkdir('data', { recursive: true, mode: 0o700 });
const db =
  mode === 'demo'
    ? memoryDatabase('data/demo')
    : postgresDatabase(process.env.DATABASE_URL!);
await migrate(db);
const repo = new Repository(db);
if (mode === 'postgres') await ensureStarterCategories(db);
// The environment is still where a password is set, exactly as it was under
// Basic authentication: edit the file on the server and restart. That is also
// the only way back in, because nothing resets a password by email yet.
if (mode === 'postgres') {
  await seedOwners(db, [
    {
      owner: 'rodion',
      email: process.env.RODION_EMAIL ?? '',
      password: process.env.RODION_PASSWORD ?? '',
    },
    {
      owner: 'katya',
      email: process.env.KATYA_EMAIL ?? '',
      password: process.env.KATYA_PASSWORD ?? '',
    },
  ]);
  await forgetExpiredSessions(db);
}
let consent: ConsentService | undefined;
const credentialsByOwner =
  mode === 'postgres'
    ? {
        rodion: await loadEnableBankingCredentials(process.env, 'rodion'),
        katya: await loadEnableBankingCredentials(process.env, 'katya'),
      }
    : {};
if (
  mode === 'postgres' &&
  (credentialsByOwner.rodion || credentialsByOwner.katya)
) {
  if (
    !process.env.PUBLIC_ORIGIN ||
    !process.env.ENABLEBANKING_SESSION_DIRECTORY
  )
    throw new Error('Incomplete Enable Banking consent configuration');
  consent = new ConsentService({
    db,
    credentialsByOwner,
    redirectUrl: new URL(
      '/connections/enablebanking/callback',
      process.env.PUBLIC_ORIGIN,
    ).toString(),
    secretDirectory: process.env.ENABLEBANKING_SESSION_DIRECTORY,
  });
  await consent.initialize();
}
const classifierKey =
  mode === 'postgres' && process.env.OPENAI_API_KEY_FILE
    ? (await readFile(process.env.OPENAI_API_KEY_FILE, 'utf8')).trim()
    : undefined;
const telegram =
  mode === 'postgres' &&
  process.env.TELEGRAM_BOT_TOKEN_FILE &&
  process.env.TELEGRAM_CHAT_ID &&
  process.env.TELEGRAM_RODION_USER_ID &&
  process.env.TELEGRAM_KATYA_USER_ID
    ? new TelegramClarifications(
        db,
        {
          chatId: process.env.TELEGRAM_CHAT_ID,
          userIds: {
            rodion: process.env.TELEGRAM_RODION_USER_ID,
            katya: process.env.TELEGRAM_KATYA_USER_ID,
          },
        },
        telegramTransport(
          (await readFile(process.env.TELEGRAM_BOT_TOKEN_FILE, 'utf8')).trim(),
        ),
      )
    : undefined;
const frontendDirectory = resolve('dist/frontend');
const frontendAvailable = await stat(
  resolve(frontendDirectory, 'index.html'),
).then(
  (file) => file.isFile(),
  (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  },
);
const server = web(repo, {
  frontendDirectory: frontendAvailable ? frontendDirectory : undefined,
  telegram,
  classifierFor:
    classifierKey && process.env.OPENAI_MODEL
      ? async (actor) => {
          const nodes = await new Categories(db).listNodes();
          return new Classifier(db, {
            apiKey: classifierKey,
            model: process.env.OPENAI_MODEL,
            maxRequestsPerDay: Number(
              process.env.OPENAI_MAX_REQUESTS_PER_DAY ?? 50,
            ),
            maxInputChars: 4000,
            maxOutputTokens: LLM_OUTPUT_TOKEN_LIMIT,
            timeoutMs: 20000,
            categories: assignablePaths(nodes),
            tags: (await new Categories(db).listTags()).map((t) => t.name),
          });
        }
      : undefined,
  consent,
  holdingFeeds:
    mode === 'postgres'
      ? {
          credentials: () =>
            loadFeedCredentials(process.env.CREDENTIALS_DIRECTORY),
          fetcher: (url, init) =>
            fetch(url, {
              ...init,
              redirect: 'error',
              signal: AbortSignal.timeout(20000),
            }),
          ethRpcUrl: process.env.ETH_RPC_URL,
        }
      : undefined,
  credentialHealth:
    mode === 'postgres'
      ? () => credentialsHealthFromEnv(process.env)
      : undefined,
  lastBackupAt:
    mode === 'postgres' && process.env.BACKUP_DIRECTORY
      ? () => newestBackupAt(process.env.BACKUP_DIRECTORY!)
      : undefined,
  port,
  mode,
  release: process.env.RELEASE_SHA ?? 'local',
  publicOrigin: process.env.PUBLIC_ORIGIN,
  monobankJarsExcluded: process.env.MONOBANK_INCLUDE_JARS === 'false',
});
let running: Promise<unknown> | null = null;
const tick = () => {
  if (mode !== 'demo' || running) return;
  running = repo
    .work(synthetic)
    .catch(() =>
      process.stderr.write(
        JSON.stringify({
          event: 'worker_error',
          code: 'synthetic_import_failed',
        }) + '\n',
      ),
    )
    .finally(() => {
      running = null;
    });
};
const timer = setInterval(tick, 1000);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    JSON.stringify({
      event: 'listening',
      url: `http://127.0.0.1:${port}`,
      mode,
    }) + '\n',
  );
  tick();
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (running) await running;
  await db.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
