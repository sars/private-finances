import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import type { Owner } from './domain.js';
import { Conflict } from './errors.js';
import { currencyExponent } from './fx.js';
import { Refunds } from './refunds.js';
import {
  TelegramError,
  validateTelegramConfig,
  type TelegramConfig,
  type TelegramTransport,
} from './telegram.js';

/**
 * Telegram questions about money that came back (ADR 0007). They exist only for
 * the cases the matcher deliberately refuses to guess: several candidate
 * purchases that differ, a reversal whose amount is unclear, and money from a
 * person. The answer is a number, matched deterministically here; no model reads
 * it, because the reply decides which purchase shrinks.
 */

export type RefundQuestionOption = {
  index: number;
  debitId: string;
  debitRevision: number;
  label: string;
};
export type RefundQuestionState =
  'queued' | 'sending' | 'sent' | 'uncertain' | 'answered' | 'stale';

/** Version 24. Refund questions and their answers. */
export async function initializeRefundQuestions(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS refund_questions (
    id uuid PRIMARY KEY,transaction_id uuid NOT NULL REFERENCES transactions(id),
    revision integer NOT NULL CHECK(revision>=0),
    owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    chat_id text NOT NULL,prompt text NOT NULL,reason text NOT NULL,
    options jsonb NOT NULL DEFAULT '[]'::jsonb,
    state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain','answered','stale')),
    message_id bigint,lease_until timestamptz,
    answer text,answered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(chat_id,message_id),UNIQUE(transaction_id,revision)
  )`);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Absolute amount as a person reads it; minor units never reach a message. */
export function amountText(minor: string, currency: string): string {
  const digits = minor.replace('-', '');
  const exponent = currencyExponent(currency);
  if (exponent === undefined) return `${digits} minor units ${currency}`;
  const padded = digits.padStart(exponent + 1, '0');
  return `${exponent ? `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}` : padded} ${currency}`;
}
function clean(value: unknown, limit = 120): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);
}
const names: Record<Owner, string> = { rodion: 'Rodion', katya: 'Katya' };

export function refundQuestionPrompt(
  owner: Owner,
  credit: {
    bookedAt: string;
    amountMinor: string;
    currency: string;
    description: string;
  },
  reason: string,
  options: RefundQuestionOption[],
): string {
  const received = `${credit.bookedAt.slice(0, 10)} · ${amountText(
    credit.amountMinor,
    credit.currency,
  )} · ${clean(credit.description)}`;
  if (!options.length)
    return [
      `${names[owner]}, money arrived that I cannot explain.`,
      received,
      reason === 'from_person'
        ? 'Only you know whether it repays something you paid for. Open Private Finances to attach it to a purchase, or reply “none” if it repays nothing.'
        : 'Open Private Finances to attach it to a purchase, or reply “none” if it returns nothing.',
    ].join('\n');
  return [
    `${names[owner]}, money came back and I will not guess which purchase it returns.`,
    received,
    ...options.map((option) => `${option.index} — ${option.label}`),
    'Reply with the number of the purchase it returns, or “none”.',
  ].join('\n');
}

/** A deterministic answer: one of the offered numbers, or an explicit refusal. */
export function parseRefundAnswer(
  text: string,
  options: RefundQuestionOption[],
):
  | { kind: 'option'; option: RefundQuestionOption }
  | { kind: 'none' }
  | { kind: 'unclear' } {
  const trimmed = String(text ?? '')
    .trim()
    .toLowerCase();
  const number = /^(?:#|option\s*)?([1-9])\b/.exec(trimmed);
  if (number) {
    const option = options.find((item) => item.index === Number(number[1]));
    return option ? { kind: 'option', option } : { kind: 'unclear' };
  }
  // A word boundary is ASCII-only, so a Cyrillic answer needs an explicit one.
  return /^(none|no|nothing|нет|ні|нема|немає|жодна)(?![\p{L}\p{N}])/u.test(
    trimmed,
  )
    ? { kind: 'none' }
    : { kind: 'unclear' };
}

export class RefundQuestions {
  private readonly settings: TelegramConfig;
  constructor(
    readonly db: Database,
    settings: TelegramConfig,
    readonly transport: TelegramTransport,
  ) {
    this.settings = validateTelegramConfig(settings);
  }
  /**
   * Asks about new money only. The backlog of unexplained credits is left to the
   * application rather than interrogated in Telegram (ADR 0007).
   */
  async queue(options: { liveFrom: Date; limit?: number }): Promise<number> {
    const limit = options.limit ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error('invalid_refund_question_limit');
    if (!options.liveFrom || !Number.isFinite(options.liveFrom.getTime()))
      throw new Error('invalid_live_questions_from');
    return this.db.transaction(async (tx) => {
      const credits = (
        await tx.query(
          `SELECT t.*,v.reason,v.candidate_ids FROM refund_match_reviews v
           JOIN transactions t ON t.id=v.transaction_id
           WHERE v.outcome='asked' AND v.revision=t.revision AND t.booked_at>=$1::timestamptz
             AND NOT EXISTS(SELECT 1 FROM refund_links r WHERE r.state='active' AND r.credit_id=t.id)
             AND NOT EXISTS(SELECT 1 FROM refund_questions q WHERE q.transaction_id=t.id AND q.revision=t.revision)
             AND NOT EXISTS(SELECT 1 FROM own_accounts a WHERE a.owner=t.owner AND a.source=t.source
                            AND a.account_id=t.account_id AND a.purpose IN ('business','investment'))
           ORDER BY t.booked_at DESC,t.id LIMIT $2 FOR UPDATE OF t`,
          [options.liveFrom.toISOString(), limit],
        )
      ).rows;
      let queued = 0;
      for (const credit of credits) {
        const ids = (credit.candidate_ids as string[]) ?? [];
        // The order the options are numbered in has to be decided by the
        // payments themselves, not by their identifiers. A question is asked
        // precisely when two charges are a whisker apart at the same moment, so
        // `booked_at` alone leaves the numbering to `gen_random_uuid()` — which
        // made this a coin flip, passing and failing the same assertion on the
        // same machine. Amount settles it: charges are negative, so ascending
        // puts the larger charge first, and only two charges identical in both
        // moment and amount fall through to the identifier, where the numbering
        // genuinely cannot matter to the person answering.
        const candidates = ids.length
          ? (
              await tx.query(
                `SELECT id,revision,booked_at,amount_minor,currency,description,category
                 FROM transactions WHERE id=ANY($1::uuid[]) AND owner=$2
                 ORDER BY booked_at,amount_minor,id`,
                [ids.slice(0, 5), credit.owner],
              )
            ).rows
          : [];
        const choices: RefundQuestionOption[] = candidates.map(
          (row, index) => ({
            index: index + 1,
            debitId: String(row.id),
            debitRevision: Number(row.revision),
            label: `${new Date(String(row.booked_at)).toISOString().slice(0, 10)} · ${amountText(
              String(row.amount_minor),
              String(row.currency),
            )} · ${clean(row.description, 60)}${
              row.category
                ? ` (${clean(row.category, 40)})`
                : ' (not categorised)'
            }`,
          }),
        );
        // A question with a single option would be the matcher's own decision
        // restated; it linked nothing, so something about it was unclear.
        const prompt = refundQuestionPrompt(
          credit.owner as Owner,
          {
            bookedAt: new Date(String(credit.booked_at)).toISOString(),
            amountMinor: String(credit.amount_minor),
            currency: String(credit.currency),
            description: String(credit.description),
          },
          String(credit.reason),
          choices,
        );
        await tx.query(
          `INSERT INTO refund_questions(id,transaction_id,revision,owner,chat_id,prompt,reason,options,state)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') ON CONFLICT(transaction_id,revision) DO NOTHING`,
          [
            randomUUID(),
            credit.id,
            Number(credit.revision),
            credit.owner,
            this.settings.chatId,
            prompt,
            String(credit.reason),
            JSON.stringify(choices),
          ],
        );
        queued++;
      }
      return queued;
    });
  }
  /** Returns a lease that expired mid-send to the queue for one more attempt. */
  async recoverExpired(): Promise<void> {
    await this.db.query(
      "UPDATE refund_questions SET state='uncertain',lease_until=NULL WHERE state='sending' AND lease_until<now()",
    );
  }
  async dispatchOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const item = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT q.* FROM refund_questions q WHERE q.state='queued' AND q.chat_id=$1
           ORDER BY q.created_at,q.id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!row) return null;
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.transaction_id,
        ])
      ).rows[0];
      const linked = await tx.query(
        "SELECT 1 FROM refund_links WHERE state='active' AND credit_id=$1",
        [row.transaction_id],
      );
      // Anything that changed since the question was written makes it wrong to
      // ask; a stale question is dropped rather than sent.
      if (
        !current ||
        current.owner !== row.owner ||
        Number(current.revision) !== Number(row.revision) ||
        linked.rows.length
      ) {
        await tx.query(
          "UPDATE refund_questions SET state='stale' WHERE id=$1",
          [row.id],
        );
        return null;
      }
      await tx.query(
        "UPDATE refund_questions SET state='sending',lease_until=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!item) return 'idle';
    try {
      const result = await this.transport.send(
        String(item.chat_id),
        String(item.prompt),
        { forceReply: true },
      );
      if (!positiveId(result.messageId)) throw new TelegramError('uncertain');
      const saved = await this.db.query(
        "UPDATE refund_questions SET state='sent',message_id=$2,lease_until=NULL WHERE id=$1 AND state='sending' AND lease_until>=now() RETURNING id",
        [item.id, result.messageId],
      );
      if (!saved.rows.length) {
        await this.db.query(
          "UPDATE refund_questions SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
          [item.id],
        );
        return 'uncertain';
      }
      return 'sent';
    } catch {
      await this.db.query(
        "UPDATE refund_questions SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
        [item.id],
      );
      return 'uncertain';
    }
  }
  /**
   * One reply to one refund question. Returns true when the update belongs to
   * this flow, so the caller stops offering it to the classification workflow.
   */
  async receive(raw: unknown): Promise<boolean> {
    const update = record(raw),
      message = record(update?.message),
      chat = record(message?.chat),
      from = record(message?.from),
      reply = record(message?.reply_to_message);
    if (
      !Number.isSafeInteger(update?.update_id) ||
      Number(update?.update_id) < 0 ||
      !Number.isSafeInteger(chat?.id) ||
      String(chat?.id) !== this.settings.chatId ||
      !positiveId(from?.id) ||
      from?.is_bot === true ||
      !positiveId(reply?.message_id) ||
      typeof message?.text !== 'string' ||
      !message.text.trim() ||
      message.text.length > 4000
    )
      return false;
    const actor = (['rodion', 'katya'] as const).find(
      (key) => this.settings.userIds[key] === String(from.id),
    );
    if (!actor) return false;
    const text = message.text;
    const outcome = await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',
        [update!.update_id],
      );
      if (!inserted.rows.length) return null;
      const question = (
        await tx.query(
          `SELECT * FROM refund_questions WHERE chat_id=$1 AND message_id=$2 AND owner=$3
           AND state='sent' FOR UPDATE`,
          [this.settings.chatId, reply!.message_id, actor],
        )
      ).rows[0];
      if (!question) return null;
      const options = (question.options as RefundQuestionOption[]) ?? [];
      const answer = parseRefundAnswer(text, options);
      if (answer.kind === 'unclear')
        return {
          question,
          reply: options.length
            ? 'Reply with the number of the purchase this returns, or “none”.'
            : 'Reply “none” if this repays nothing, or attach it to a purchase in Private Finances.',
        };
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          question.transaction_id,
        ])
      ).rows[0];
      if (
        !current ||
        current.owner !== actor ||
        Number(current.revision) !== Number(question.revision)
      ) {
        await this.close(tx, question.id, 'stale', text);
        return {
          question,
          reply:
            'This payment changed since I asked, so I did not link anything. Please check it in Private Finances.',
        };
      }
      if (answer.kind === 'none') {
        await this.close(tx, question.id, 'answered', text);
        await tx.query(
          `UPDATE refund_match_reviews SET outcome='unmatched',reason='owner_said_none',decided_at=now()
           WHERE transaction_id=$1`,
          [question.transaction_id],
        );
        return {
          question,
          reply:
            'Understood. It stays visible as incoming money nobody has explained.',
        };
      }
      const scoped: Database = {
        query: (sql, params) => tx.query(sql, params),
        transaction: (action) => action(tx),
        close: async () => {},
      };
      try {
        await new Refunds(scoped).link({
          debitId: answer.option.debitId,
          creditId: String(question.transaction_id),
          expectedDebitRevision: answer.option.debitRevision,
          expectedCreditRevision: Number(question.revision),
          owner: actor,
          origin: 'manual',
          rule: 'owner_confirmed',
          reason: 'Owner chose this purchase in Telegram',
          tx,
        });
      } catch (error) {
        await this.close(tx, question.id, 'stale', text);
        return {
          question,
          reply:
            error instanceof Conflict
              ? 'Something changed while I was linking it, so nothing was linked. Please check it in Private Finances.'
              : 'I could not link that purchase. Please attach it in Private Finances.',
        };
      }
      await this.close(tx, question.id, 'answered', text);
      await tx.query(
        `UPDATE refund_match_reviews SET outcome='linked',reason='owner_confirmed',decided_at=now()
         WHERE transaction_id=$1`,
        [question.transaction_id],
      );
      return {
        question,
        reply: `Linked. It reduces ${answer.option.label}.`,
      };
    });
    if (!outcome) return false;
    try {
      await this.transport.reply(
        this.settings.chatId,
        Number(reply!.message_id),
        outcome.reply,
      );
    } catch {
      // The decision is already stored; a failed acknowledgement is not a reason
      // to reconsider it, and the app shows the result either way.
    }
    return true;
  }
  private async close(
    tx: Executor,
    id: unknown,
    state: Extract<RefundQuestionState, 'answered' | 'stale'>,
    answer: string,
  ): Promise<void> {
    await tx.query(
      'UPDATE refund_questions SET state=$2,answer=$3,answered_at=now() WHERE id=$1',
      [id, state, answer.slice(0, 1000)],
    );
  }
  async pending(actor: Owner): Promise<Row[]> {
    return (
      await this.db.query(
        `SELECT id,transaction_id,revision,state,reason,created_at FROM refund_questions
         WHERE owner=$1 AND state IN ('queued','sending','sent','uncertain') ORDER BY created_at DESC,id`,
        [actor],
      )
    ).rows;
  }
}
