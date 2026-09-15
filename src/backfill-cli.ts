import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate, postgresDatabase } from './database.js';
import { Repository } from './repository.js';
import { syncBank } from './bank-sync.js';
import { runBackfill } from './backfill.js';
import { MonobankConnector } from './connectors/monobank.js';
import { EnableBankingConnector } from './connectors/enablebanking.js';
import { requester } from './connectors/http.js';
import { ConnectorError } from './connectors/types.js';
import { loadEnableBankingCredentials } from './enablebanking-credentials.js';

async function secret(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65536)
    throw new Error('invalid_secret_file');
  return (await readFile(path, 'utf8')).trim();
}
const log = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');

async function main() {
  const [provider, owner, fromArg, toArg, bankArg, extra] =
    process.argv.slice(2);
  if (
    (provider !== 'monobank' && provider !== 'enablebanking') ||
    (owner !== 'rodion' && owner !== 'katya') ||
    !fromArg ||
    !toArg ||
    extra ||
    !process.env.DATABASE_URL ||
    !process.env.CREDENTIALS_DIRECTORY
  )
    throw new Error('backfill_configuration');
  const from = new Date(fromArg),
    to = new Date(toArg);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() > Date.now() ||
    from.getTime() % 1000 !== 0 ||
    to.getTime() % 1000 !== 0
  )
    throw new Error('invalid_backfill_window');
  const bank = bankArg ?? process.env.ENABLEBANKING_BANK;
  if (provider === 'enablebanking' && bank !== 'wise' && bank !== 'revolut')
    throw new Error('backfill_configuration');
  if (
    provider === 'enablebanking' &&
    !process.env.ENABLEBANKING_SESSION_DIRECTORY
  )
    throw new Error('backfill_configuration');
  const credentials =
    provider === 'enablebanking'
      ? await loadEnableBankingCredentials(process.env, owner)
      : undefined;
  if (provider === 'enablebanking' && !credentials)
    throw new Error('backfill_configuration');
  const connector =
    provider === 'monobank'
      ? new MonobankConnector(
          owner,
          await secret(
            resolve(
              process.env.CREDENTIALS_DIRECTORY,
              owner === 'rodion'
                ? 'monobank-rodion-token'
                : 'monobank-kate-token',
            ),
          ),
          requester('https://api.monobank.ua', 61000),
          process.env.MONOBANK_INCLUDE_JARS !== 'false',
        )
      : new EnableBankingConnector(
          {
            owner,
            bank: bank as 'wise' | 'revolut',
            applicationId: credentials!.applicationId,
            privateKey: credentials!.privateKey,
            sessionId: await secret(
              resolve(
                process.env.ENABLEBANKING_SESSION_DIRECTORY!,
                `enablebanking-${owner}-${bank}-session`,
              ),
            ),
          },
          requester('https://api.enablebanking.com'),
        );
  const db = postgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    const repo = new Repository(db);
    const connection = `${provider}:${owner}${provider === 'enablebanking' ? `:${bank}` : ''}`;
    const result = await runBackfill(connector, from, to, {
      covered: async (account, window) =>
        (
          await db.query(
            `SELECT 1 FROM bank_import_windows WHERE connection=$1 AND owner=$2 AND account_id=$3 AND currency=$4 AND from_at<=$5 AND to_at>=$6 LIMIT 1`,
            [
              connection,
              owner,
              account.accountId,
              account.currency,
              window.from.toISOString(),
              window.to.toISOString(),
            ],
          )
        ).rows.length > 0,
      sync: (current, start, end) => syncBank(repo, current, start, end),
      progress: log,
    });
    log({
      event: 'backfill_completed',
      provider,
      owner,
      from: from.toISOString(),
      to: to.toISOString(),
      ...result,
    });
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      event: 'backfill_failed',
      code:
        error instanceof ConnectorError
          ? error.code
          : 'configuration_or_backfill_error',
    }) + '\n',
  );
  process.exitCode = 1;
});
