import { previousReportPeriod } from './reports.js';
import type { Database } from './database.js';
import type { Owner } from './domain.js';
import {
  activeQuestionForPayment,
  type TelegramClarifications,
} from './telegram.js';
import { currencyExponent } from './fx.js';

export type ClarificationBotFactory = (
  db: Database,
) => Pick<TelegramClarifications, 'queue'>;

function amountText(minor: string, currency: string): string {
  const amount = (-BigInt(minor)).toString();
  const exponent = currencyExponent(currency);
  if (exponent === undefined) return `${amount} minor units ${currency}`;
  const digits = amount.padStart(exponent + 1, '0');
  return `${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits} ${currency}`;
}

/** Explicit UTC rollout boundary; reject malformed dates rather than sending backlog. */
export function liveQuestionsFrom(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    throw new Error('invalid_live_questions_from');
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value.replace(/(?<=:\d{2})Z$/, '.000Z')
  )
    throw new Error('invalid_live_questions_from');
  return date;
}

/** Call only after explicit auto-question enablement. This queues; it never sends. */
export async function queueDailyClarifications(
  db: Database,
  makeBot: ClarificationBotFactory,
  now = new Date(),
  liveFrom?: Date,
): Promise<Record<Owner, number>> {
  if (!Number.isFinite(now.getTime()))
    throw new Error('invalid_clarification_date');
  if (liveFrom && !Number.isFinite(liveFrom.getTime()))
    throw new Error('invalid_live_questions_from');
  const timestamp = now.toISOString();
  const recentFrom =
    liveFrom?.toISOString() ?? previousReportPeriod('month', now).to;
  const from = `${timestamp.slice(0, 10)}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  return db.transaction(async (tx) => {
    // Account edits take this lock too; keep purpose stable through queueing.
    await tx.query('SELECT pg_advisory_xact_lock(7482393)');
    await tx.query('SELECT pg_advisory_xact_lock(7482399)');
    const scoped: Database = {
      query: (sql, params) => tx.query(sql, params),
      transaction: (action) => action(tx),
      close: async () => {},
    };
    const bot = makeBot(scoped);
    const queued: Record<Owner, number> = { rodion: 0, katya: 0 };
    for (const owner of ['rodion', 'katya'] as const) {
      const count = liveFrom
        ? 0
        : Number(
            (
              await tx.query(
                'SELECT count(*)::int AS count FROM telegram_outbox WHERE owner=$1 AND created_at>=$2 AND created_at<$3',
                [owner, from, to],
              )
            ).rows[0]!.count,
          );
      // Bound each transaction; subsequent loops drain new payments without a daily cap.
      const remaining = liveFrom ? 50 : Math.max(0, 5 - count);
      if (!remaining) continue;
      const rows = (
        await tx.query(
          `SELECT t.*,q.question,q.state
        FROM transactions t JOIN transaction_triage q ON q.transaction_id=t.id AND q.revision=t.revision AND q.owner=t.owner
        WHERE ((q.state='ready' AND q.question IS NOT NULL) OR ($5=true AND q.state IN ('deferred','uncertain'))) AND t.owner=$1 AND (t.kind='unresolved' OR t.provisional) AND (t.status='booked' OR ($5=true AND t.status='pending')) AND t.amount_minor<0
        AND t.source<>'manual_cash'
        AND NOT EXISTS(SELECT 1 FROM transaction_explanations e WHERE e.transaction_id=t.id AND e.revision=t.revision AND e.status='pending')
        AND t.booked_at >= $3 AND t.booked_at <= $4
        AND NOT EXISTS(SELECT 1 FROM telegram_outbox o WHERE o.transaction_id=t.id AND o.revision=t.revision)
        AND NOT EXISTS(SELECT 1 FROM own_accounts a WHERE a.owner=t.owner AND a.source=t.source AND a.account_id=t.account_id AND a.purpose IN ('business','investment'))
        AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.transaction_id=t.id AND a.event IN ('classified','refund_linked','refund_unlinked'))
        ORDER BY t.booked_at DESC,t.id LIMIT $2 FOR UPDATE OF t`,
          [owner, remaining, recentFrom, timestamp, Boolean(liveFrom)],
        )
      ).rows;
      for (const row of rows) {
        if (await activeQuestionForPayment(tx, row)) continue;
        const date = (
          row.booked_at instanceof Date
            ? row.booked_at
            : new Date(String(row.booked_at))
        )
          .toISOString()
          .slice(0, 10);
        // Description is quoted context only. No category or financial policy is inferred.
        const description = String(row.description)
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, 500);
        const prompt = `${owner === 'rodion' ? 'Rodion' : 'Katya'}, ${String(
          row.state === 'ready'
            ? row.question
            : 'Automatic review could not determine this payment’s purpose. What was it for: personal spending, business, or a transfer?',
        )
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(
            0,
            800,
          )}\n${date} (UTC) · ${amountText(String(row.amount_minor), String(row.currency))}${row.status === 'pending' ? '\nBank processing · amount may change until settled.' : ''}\nBank description: ${description}\nReply to this message with context. It will remain unresolved until reviewed.`;
        const id = await bot.queue(
          String(row.id),
          Number(row.revision),
          prompt,
          owner,
        );
        // The supplied clock is the cycle timestamp, including in deterministic tests.
        await tx.query('UPDATE telegram_outbox SET created_at=$2 WHERE id=$1', [
          id,
          timestamp,
        ]);
        queued[owner]++;
      }
    }
    return queued;
  });
}
