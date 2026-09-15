import { readFile, stat } from 'node:fs/promises';
import { postgresDatabase, migrate } from './database.js';
import {
  Categories,
  assignablePaths,
  ensureStarterCategories,
} from './categories.js';
import { Classifier } from './classifier.js';
import { LLM_OUTPUT_TOKEN_LIMIT } from './llm-budget.js';
import { loadHistoricalKnowledge } from './historical-knowledge.js';
import { TransactionTriage } from './transaction-triage.js';

/** Operator-invoked bulk pass; shares the same atomic dollar budget as Telegram. */
async function main() {
  if (
    process.env.AUTO_CATEGORIZE_CLEAR_EXPENSES !== 'true' ||
    !process.env.DATABASE_URL ||
    !process.env.OPENAI_API_KEY_FILE ||
    !process.env.OPENAI_MODEL
  )
    throw new Error('categorization_configuration');
  const limit = Number(process.env.CATEGORIZE_MAX_TRANSACTIONS ?? 10000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000)
    throw new Error('categorization_configuration');
  const info = await stat(process.env.OPENAI_API_KEY_FILE);
  if (!info.isFile() || info.size > 1024 || (info.mode & 0o077) !== 0)
    throw new Error('categorization_configuration');
  const apiKey = (
    await readFile(process.env.OPENAI_API_KEY_FILE, 'utf8')
  ).trim();
  const knowledge = process.env.HISTORICAL_KNOWLEDGE_FILE
    ? await loadHistoricalKnowledge(process.env.HISTORICAL_KNOWLEDGE_FILE)
    : undefined;
  const db = postgresDatabase(process.env.DATABASE_URL);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let processed = 0;
  try {
    await migrate(db);
    await ensureStarterCategories(db);
    const classifiers = {} as Record<'rodion' | 'katya', Classifier>;
    for (const owner of ['rodion', 'katya'] as const) {
      const nodes = await new Categories(db).listNodes();
      classifiers[owner] = new Classifier(db, {
        apiKey,
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
    const triage = new TransactionTriage(
      db,
      (owner) => classifiers[owner],
      knowledge,
      { autoCategorizeClearExpenses: true },
    );
    while (!stopped && processed < limit && (await triage.processOne())) {
      processed++;
      if (processed % 25 === 0)
        process.stdout.write(
          JSON.stringify({ event: 'categorization_progress', processed }) +
            '\n',
        );
    }
    process.stdout.write(
      JSON.stringify({
        event: 'categorization_pass_finished',
        processed,
        stopped,
        limitReached: processed === limit,
      }) + '\n',
    );
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await db.close();
  }
}
main().catch(() => {
  process.stderr.write('{"event":"categorization_pass_failed"}\n');
  process.exitCode = 1;
});
