import {
  Receipts,
  receiptDownloader,
  popplerRasterizer,
  responsesRequester,
} from './receipts.js';
import { ReceiptCategorization } from './receipt-categorization.js';
import { TransactionTriage } from './transaction-triage.js';
import { loadHistoricalKnowledge } from './historical-knowledge.js';
import { LLM_OUTPUT_TOKEN_LIMIT } from './llm-budget.js';
import {
  TelegramReplyWorkflow,
  hierarchicalCategoryPaths,
  initializeReplyWorkflow,
} from './reply-workflow.js';
import { Classifier } from './classifier.js';
import { Categories, ensureStarterCategories } from './categories.js';
import {
  CredentialReminders,
  initializeCredentialHealth,
} from './credential-health.js';
import {
  liveQuestionsFrom,
  queueDailyClarifications,
} from './clarification-cycle.js';
import { RefundMatcher } from './refund-automation.js';
import { RefundQuestions } from './refund-questions.js';
import { Reports } from './reports.js';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  migrate,
  postgresDatabase,
  type Database,
  type Executor,
} from './database.js';
import {
  NOT_A_REPLY,
  TelegramClarifications,
  telegramTransport,
  type TelegramConfig,
} from './telegram.js';

export type TelegramPoller = (offset: number) => Promise<unknown[]>;
export async function initializeTelegramCursor(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_poll_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),next_update_id bigint NOT NULL CHECK(next_update_id>=0)
  )`);
  await tx.query(
    'INSERT INTO telegram_poll_cursor(singleton,next_update_id) VALUES(true,0) ON CONFLICT DO NOTHING',
  );
}
export function telegramPoller(
  token: string,
  fetcher: typeof fetch = fetch,
): TelegramPoller {
  telegramTransport(token); // Validate credentials before constructing the fixed-origin polling URL.
  return async (offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('telegram_cursor_invalid');
    try {
      const response = await fetcher(
        `https://api.telegram.org/bot${token}/getUpdates`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            offset,
            limit: 50,
            timeout: 10,
            allowed_updates: ['message'],
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('telegram_poll_failed');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('telegram_poll_failed');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) {
          await reader.cancel();
          throw new Error('telegram_poll_failed');
        }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
      if (
        body?.ok !== true ||
        !Array.isArray(body.result) ||
        body.result.length > 50
      )
        throw new Error('telegram_poll_failed');
      return body.result;
    } catch {
      throw new Error('telegram_poll_failed');
    }
  };
}

// Poll and receive share one transaction, so a crash cannot acknowledge an update
// without persisting its proposal input. The advisory lock serializes workers.
export async function pollOnce(
  db: Database,
  settings: TelegramConfig,
  poll: TelegramPoller,
  receiveWorkflow?: (db: Database, update: unknown) => Promise<boolean>,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7482398)');
    const current = (
      await tx.query(
        'SELECT next_update_id FROM telegram_poll_cursor WHERE singleton=true FOR UPDATE',
      )
    ).rows[0];
    const offset = Number(current?.next_update_id);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('telegram_cursor_invalid');
    const updates = await poll(offset);
    if (!Array.isArray(updates) || updates.length > 50)
      throw new Error('telegram_poll_failed');
    const normalized = updates
      .map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('telegram_update_invalid');
        const update = raw as Record<string, unknown>;
        if (
          !Number.isSafeInteger(update.update_id) ||
          Number(update.update_id) < 0 ||
          Number(update.update_id) >= Number.MAX_SAFE_INTEGER
        )
          throw new Error('telegram_update_invalid');
        return update;
      })
      .sort((a, b) => Number(a.update_id) - Number(b.update_id));
    const scoped: Database = {
      query: (sql, params) => tx.query(sql, params),
      transaction: (action) => action(tx),
      close: async () => {},
    };
    const bot = new TelegramClarifications(scoped, settings, {
      async send() {
        throw new Error('telegram_receive_only');
      },
      async react() {
        throw new Error('telegram_receive_only');
      },
      async reply() {
        throw new Error('telegram_receive_only');
      },
    });
    let next = offset;
    for (const update of normalized) {
      if (Number(update.update_id) < next) continue;
      if (!(receiveWorkflow && (await receiveWorkflow(scoped, update)))) {
        const { outcome, detail } = await bot.receiveDetailed(update);
        // A household member's answer that reached nothing is a failure to
        // report, not a quiet no-op: without this the only trace was an
        // update number, and nobody could say what had rejected it. A
        // duplicate is logged too: three answers were lost on 17 September
        // 2026 as duplicates, when an earlier consumer had taken the number.
        if (outcome !== 'accepted' && detail !== NOT_A_REPLY)
          process.stdout.write(
            `${JSON.stringify({
              event: 'telegram_reply_discarded',
              updateId: Number(update.update_id),
              outcome,
              ...(detail ? { detail } : {}),
            })}\n`,
          );
      }
      next = Number(update.update_id) + 1;
    }
    await tx.query(
      'UPDATE telegram_poll_cursor SET next_update_id=GREATEST(next_update_id,$1) WHERE singleton=true',
      [next],
    );
    return next;
  });
}

async function main(): Promise<void> {
  const liveFrom = liveQuestionsFrom(process.env.TELEGRAM_LIVE_QUESTIONS_FROM);
  const path = process.env.TELEGRAM_BOT_TOKEN_FILE;
  const settings: TelegramConfig = {
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    userIds: {
      rodion: process.env.TELEGRAM_RODION_USER_ID ?? '',
      katya: process.env.TELEGRAM_KATYA_USER_ID ?? '',
    },
    // The same origin the dashboard is served on, so a message about a payment
    // can link straight to it. Left out when it is not configured.
    ...(process.env.PUBLIC_ORIGIN
      ? { publicOrigin: process.env.PUBLIC_ORIGIN }
      : {}),
  };
  if (
    !path ||
    !process.env.DATABASE_URL ||
    !settings.chatId ||
    !settings.userIds.rodion ||
    !settings.userIds.katya
  )
    throw new Error('telegram_configuration');
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024)
    throw new Error('telegram_configuration');
  const token = (await readFile(path, 'utf8')).trim();
  const transport = telegramTransport(token);
  const keyPath = process.env.OPENAI_API_KEY_FILE;
  let classifierKey: string | undefined;
  if (keyPath) {
    const keyInfo = await stat(keyPath);
    if (
      !keyInfo.isFile() ||
      (keyInfo.mode & 0o077) !== 0 ||
      keyInfo.size > 1024
    )
      throw new Error('classifier_configuration');
    classifierKey = (await readFile(keyPath, 'utf8')).trim();
  }
  const historicalKnowledge = process.env.HISTORICAL_KNOWLEDGE_FILE
    ? await loadHistoricalKnowledge(process.env.HISTORICAL_KNOWLEDGE_FILE)
    : undefined;
  const db = postgresDatabase(process.env.DATABASE_URL);
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const bot = new TelegramClarifications(db, settings, transport);
    await migrate(db);
    await db.transaction(initializeTelegramCursor);
    await db.transaction(initializeReplyWorkflow);
    const classifierFor = async (actor: 'rodion' | 'katya') =>
      new Classifier(db, {
        apiKey: classifierKey,
        model: process.env.OPENAI_MODEL,
        maxRequestsPerDay: Number(
          process.env.OPENAI_MAX_REQUESTS_PER_DAY ?? 50,
        ),
        maxInputChars: 4000,
        maxOutputTokens: LLM_OUTPUT_TOKEN_LIMIT,
        timeoutMs: 20000,
        categories: hierarchicalCategoryPaths(
          await new Categories(db).listNodes(),
        ).slice(0, 100),
        tags: (await new Categories(db).listTags()).map((t) => t.name),
      });
    await ensureStarterCategories(db);
    const triage = new TransactionTriage(
      db,
      classifierFor,
      historicalKnowledge,
      {
        notBefore: '2025-12-31T22:00:00Z',
        autoCategorizeClearExpenses:
          process.env.AUTO_CATEGORIZE_CLEAR_EXPENSES === 'true',
      },
    );
    const workflow = new TelegramReplyWorkflow(
      db,
      settings,
      transport,
      classifierFor,
    );
    await db.transaction(initializeCredentialHealth);
    const credentialReminders = new CredentialReminders(
      db,
      settings.chatId,
      transport,
    );
    const poll = telegramPoller(token);
    const receipts = new Receipts(db);
    const downloadReceipt = receiptDownloader(token);
    // PDF receipts are rendered to page images by poppler, behind the
    // replaceable PdfRasterizer interface.
    const rasterizeReceipt = popplerRasterizer();
    const requestReceipt = responsesRequester(classifierKey ?? '');
    const receiptCategories = new ReceiptCategorization(db, classifierFor);
    // Refund matching needs no AI key and no secrets: it compares what the
    // merchant charged with what it returned (ADR 0007).
    const refundMatcher = new RefundMatcher(db);
    const refundQuestions = new RefundQuestions(db, settings, transport);
    let nextReceiptMatchCheck = 0;
    let nextRefundMatchCheck = 0;
    while (!stopped) {
      if (Date.now() >= nextRefundMatchCheck) {
        // A link made from a hold is recalculated, or removed, once the bank
        // settles the amount it was made from. A failure here is reported and
        // the loop continues: refund matching must never take Telegram,
        // receipts and triage down with it, as it did on 14 September.
        try {
          await refundMatcher.reviewSettledLinks();
          // Links the matcher chose under older rules are released first, so the
          // drain below re-assigns them together with anything new.
          await refundMatcher.reassignOwnLinks();
          // Drain the queue rather than trickling twenty-five a minute: after a
          // rule changes there are hundreds of decisions to re-read, and the
          // work is arithmetic over a few thousand rows. Bounded so a pass can
          // never run away with the loop.
          for (let batch = 0; batch < 40; batch++) {
            const decided = await refundMatcher.matchPending();
            if (decided.linked + decided.asked + decided.unmatched === 0) break;
          }
        } catch (error) {
          process.stderr.write(
            JSON.stringify({
              event: 'refund_pass_failed',
              code:
                error instanceof Error ? error.message.slice(0, 80) : 'unknown',
            }) + '\n',
          );
        }
        // Only money that arrived after the rollout boundary is asked about;
        // the backlog stays in the application (ADR 0007).
        if (process.env.TELEGRAM_AUTO_QUESTIONS === 'true' && liveFrom) {
          await refundQuestions.recoverExpired();
          await refundQuestions.queue({ liveFrom });
        }
        nextRefundMatchCheck = Date.now() + 60000;
      }
      if (process.env.TELEGRAM_AUTO_QUESTIONS === 'true')
        await refundQuestions.dispatchOne();
      if (Date.now() >= nextReceiptMatchCheck) {
        await receipts.retryPendingMatches();
        // Linked receipts whose payment the bank revised afterwards: a settled
        // amount that no longer equals the receipt total is recorded and shown.
        await receipts.reviewSettledMatches();
        if (process.env.AUTO_CATEGORIZE_CLEAR_EXPENSES === 'true')
          await receiptCategories.processOne();
        nextReceiptMatchCheck = Date.now() + 60000;
      }
      await bot.recoverExpired();
      await credentialReminders.enqueue(
        process.env.OPENAI_API_KEY_EXPIRES_ON ??
          process.env.OPENAI_API_KEY_EXPIRES_AT,
      );
      // A bank approval lasts days, not months, and when it lapses the imports
      // stop without a word anywhere else.
      await credentialReminders.enqueueBankConsents();
      await credentialReminders.dispatchOne();
      if (
        process.env.TELEGRAM_AUTO_QUESTIONS === 'true' ||
        process.env.AUTO_CATEGORIZE_CLEAR_EXPENSES === 'true'
      )
        await triage.processOne();
      if (process.env.TELEGRAM_AUTO_QUESTIONS === 'true')
        await queueDailyClarifications(
          db,
          (scoped) => new TelegramClarifications(scoped, settings, transport),
          new Date(),
          liveFrom,
        );
      if (classifierKey)
        await receipts.processOne({
          model: process.env.OPENAI_MODEL ?? 'gpt-5.4-mini',
          maxRequestsPerDay: Number(
            process.env.OPENAI_MAX_REQUESTS_PER_DAY ?? 50,
          ),
          download: downloadReceipt,
          request: requestReceipt,
          rasterize: rasterizeReceipt,
        });
      // Feedback on already-stored jobs does not need an AI key.
      await receipts.notifyOne(transport);
      await workflow.processOne();
      await workflow.dispatchOne();
      await workflow.dispatchReceiptOne();
      await bot.dispatchOne();
      await bot.dispatchNoteOne();
      // Only household reports created after this explicit cutoff may be sent.
      const reportAfter = process.env.TELEGRAM_REPORTS_AFTER;
      if (reportAfter && Number.isFinite(Date.parse(reportAfter))) {
        for (const snapshot of await new Reports(db).list('all'))
          if (Date.parse(snapshot.createdAt) >= Date.parse(reportAfter))
            await bot.queueReport(snapshot.id, 'rodion');
        await bot.dispatchReportOne();
      }
      if (stopped) break;
      await pollOnce(
        db,
        settings,
        poll,
        async (scopedDb, update) =>
          (await new RefundQuestions(scopedDb, settings, transport).receive(
            update,
          )) ||
          (await new Receipts(scopedDb).receive(settings, update)) ||
          (await new TelegramReplyWorkflow(
            scopedDb,
            settings,
            transport,
            classifierFor,
          ).receive(update)) !== 'unmatched',
      );
      if (!stopped) await sleep(1000);
    }
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      '{"event":"telegram_runtime_stopped","code":"configuration_or_poll_error"}\n',
    );
    process.exitCode = 1;
  });
}
