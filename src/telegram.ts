import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import { isSettlementOnly, type Owner } from './domain.js';
import type { ReportContent } from './reports.js';
import { currencyExponent } from './fx.js';

export interface TelegramConfig {
  chatId: string;
  userIds: Record<Owner, string>;
  /**
   * Where the dashboard is reachable, so a message about a payment can link
   * back to it. Absent in tests and local runs, where the message simply
   * carries no link rather than an invented one.
   */
  publicOrigin?: string;
}
/** Reactions the bot is allowed to leave; Telegram rejects arbitrary emoji. */
export type TelegramReaction = '👍' | '👀' | '🙌' | null;
export interface TelegramTransport {
  send(
    chatId: string,
    text: string,
    options?: { forceReply?: boolean },
  ): Promise<{ messageId: number }>;
  /** Replaces any previous bot reaction on that message; null clears it. */
  react(
    chatId: string,
    messageId: number,
    emoji: TelegramReaction,
  ): Promise<void>;
  reply(
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<{ messageId: number }>;
}
export class TelegramError extends Error {
  constructor(readonly code: 'configuration' | 'uncertain') {
    super(`telegram_${code}`);
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function owner(value: unknown): Owner {
  if (value !== 'rodion' && value !== 'katya') throw new Error('invalid_owner');
  return value;
}
export function validateTelegramConfig(raw: TelegramConfig): TelegramConfig {
  const id = (value: unknown, negative = false) =>
    typeof value === 'string' &&
    (negative ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(value) &&
    Number.isSafeInteger(Number(value));
  if (
    !raw ||
    !id(raw.chatId, true) ||
    !raw.userIds ||
    !id(raw.userIds.rodion) ||
    !id(raw.userIds.katya) ||
    raw.userIds.rodion === raw.userIds.katya
  )
    throw new TelegramError('configuration');
  let publicOrigin: string | undefined;
  if (raw.publicOrigin !== undefined) {
    let parsed;
    try {
      parsed = new URL(raw.publicOrigin);
    } catch {
      throw new TelegramError('configuration');
    }
    if (parsed.protocol !== 'https:') throw new TelegramError('configuration');
    publicOrigin = parsed.origin;
  }
  return { chatId: raw.chatId, userIds: { ...raw.userIds }, publicOrigin };
}

export function telegramTransport(
  token: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 20000,
): TelegramTransport {
  if (
    typeof token !== 'string' ||
    !/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new TelegramError('configuration');
  // One bounded, fixed-origin request path for every method: no redirects, a
  // request timeout, a 64 KiB body cap and a single uncertain failure type.
  const call = async (
    method: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    const response = await fetcher(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new TelegramError('uncertain');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TelegramError('uncertain');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new TelegramError('uncertain');
      }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  };
  const sentMessage = (
    body: Record<string, unknown> | null,
    chatId: string,
  ): { messageId: number } => {
    const result = record(body?.result);
    const chat = record(result?.chat);
    if (
      body?.ok !== true ||
      !positiveId(result?.message_id) ||
      String(chat?.id) !== chatId
    )
      throw new TelegramError('uncertain');
    return { messageId: result.message_id };
  };
  return {
    async send(chatId, text, options) {
      try {
        return sentMessage(
          await call('sendMessage', {
            chat_id: chatId,
            text,
            ...(options?.forceReply === false
              ? {}
              : { reply_markup: { force_reply: true, selective: false } }),
          }),
          chatId,
        );
      } catch {
        throw new TelegramError('uncertain');
      }
    },
    async react(chatId, messageId, emoji) {
      try {
        const body = await call('setMessageReaction', {
          chat_id: chatId,
          message_id: messageId,
          reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        });
        if (body?.ok !== true || body?.result !== true)
          throw new TelegramError('uncertain');
      } catch {
        throw new TelegramError('uncertain');
      }
    },
    async reply(chatId, messageId, text) {
      try {
        // A plain reply: no force_reply keyboard, so it never opens an input prompt.
        return sentMessage(
          await call('sendMessage', {
            chat_id: chatId,
            text,
            reply_parameters: {
              message_id: messageId,
              allow_sending_without_reply: true,
            },
          }),
          chatId,
        );
      } catch {
        throw new TelegramError('uncertain');
      }
    },
  };
}

function reportText(report: ReportContent, version: number): string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: report.period.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const amount = (minor: string, currency: string) => {
    if (!/^\d+$/.test(minor)) throw new Error('invalid_report_amount');
    const exponent = currencyExponent(currency);
    if (exponent === undefined) return `${minor} minor units`;
    const digits = BigInt(minor)
      .toString()
      .padStart(exponent + 1, '0');
    return exponent
      ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
      : digits;
  };
  const lines = [
    `${report.period.kind === 'week' ? 'Weekly' : 'Monthly'} report · ${report.owner === 'all' ? 'Family' : report.owner} · revision ${version}`,
    `${format.format(new Date(report.period.from))} – ${format.format(new Date(Date.parse(report.period.to) - 1))} (${report.period.timeZone})`,
    `Imported transactions: ${report.transactionCount}`,
    `Incomplete: ${report.incompleteness.unresolvedCount} unresolved; ${report.incompleteness.pendingCount} pending.`,
    'Bank import coverage unverified. Currencies shown separately; no conversion.',
  ];
  if (!report.byCurrency.length)
    lines.push(
      'No imported transactions in this period; this does not prove zero spending.',
    );
  const currencies = [...report.byCurrency].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
  for (let i = 0; i < currencies.length; i++) {
    const row = currencies[i]!;
    if (!/^[A-Z]{3}$/.test(row.currency))
      throw new Error('invalid_report_currency');
    const line = `${row.currency}: personal ${amount(row.personalExpenseMinor, row.currency)}; unresolved ${amount(row.unresolvedOutflowMinor, row.currency)} (${row.unresolvedCount}); pending ${amount(row.pendingOutflowMinor, row.currency)} (${row.pendingCount}).`;
    if (lines.join('\n').length + line.length > 3700) {
      lines.push(
        `${currencies.length - i} more currencies: open dashboard for full report.`,
      );
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export async function initializeTelegram(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS report_delivery (
    id uuid PRIMARY KEY,report_id uuid NOT NULL UNIQUE REFERENCES report_snapshots(id),
    actor text NOT NULL CHECK(actor IN ('rodion','katya')),chat_id text NOT NULL,text text NOT NULL,
    state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain')),
    message_id bigint,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(chat_id,message_id)
  )`);
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_outbox (
    id uuid PRIMARY KEY,transaction_id uuid NOT NULL REFERENCES transactions(id),
    revision integer NOT NULL CHECK(revision>=0),owner text NOT NULL CHECK(owner IN ('rodion','katya')),
    chat_id text NOT NULL,prompt text NOT NULL,
    state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain')),
    message_id bigint,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(chat_id,message_id),UNIQUE(transaction_id,revision)
  )`);
  await tx.query(
    'ALTER TABLE telegram_outbox ADD COLUMN IF NOT EXISTS payment_snapshot jsonb',
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id bigint PRIMARY KEY,received_at timestamptz NOT NULL DEFAULT now()
  )`);
  // What became of each message a household member sent us. Two of Katya's
  // answers were consumed by the poller on 15 September 2026, matched nothing,
  // and vanished leaving only an update number: the payments stayed unresolved,
  // she was never told, and afterwards no one could say which check had
  // rejected them. The reason is recorded here so the next one is answerable.
  await tx.query(
    'ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS outcome text',
  );
  await tx.query(
    'ALTER TABLE telegram_updates ADD COLUMN IF NOT EXISTS detail text',
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_proposal_inputs (
    id uuid PRIMARY KEY,outbox_id uuid NOT NULL REFERENCES telegram_outbox(id),
    update_id bigint NOT NULL UNIQUE REFERENCES telegram_updates(update_id),
    owner text NOT NULL CHECK(owner IN ('rodion','katya')),input_text text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK(status='pending'),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  // The owner's own message, so the bot can react to it and answer it in
  // place. Rows written before this have none, and are answered without a
  // reply target rather than being repaired.
  await tx.query(
    'ALTER TABLE telegram_proposal_inputs ADD COLUMN IF NOT EXISTS message_id bigint',
  );
}

function paymentSnapshot(row: Row): Record<string, unknown> {
  return {
    owner: row.owner,
    source: row.source,
    accountId: row.account_id,
    amountMinor: String(row.amount_minor),
    currency: row.currency,
    bookedAt: new Date(String(row.booked_at)).toISOString(),
    description: row.description,
    status: row.status,
    sourceDetails: row.source_details ?? {},
  };
}

/** Only settlement of the exact same unresolved payment can preserve a question. */
export async function rebasePendingQuestion(
  tx: Executor,
  question: Row,
  current: Row,
): Promise<boolean> {
  if (question.owner !== current.owner) return false;
  if (Number(question.revision) === Number(current.revision)) return true;
  const before = question.payment_snapshot as Record<string, unknown> | null;
  // A provisional placement is where the evidence pointed, not a decision, so a
  // question about it is still live; only a person's decision retires one.
  if (
    !before ||
    before.status !== 'pending' ||
    current.status !== 'booked' ||
    (current.kind !== 'unresolved' && current.provisional !== true)
  )
    return false;
  const after = paymentSnapshot(current);
  if (!isSettlementOnly(before, after)) return false;
  const human = await tx.query(
    "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event IN ('classified','refund_linked','refund_unlinked') LIMIT 1",
    [current.id],
  );
  if (human.rows.length) return false;
  const changed = await tx.query(
    `UPDATE telegram_outbox SET revision=$2,payment_snapshot=$3 WHERE id=$1
    AND NOT EXISTS(SELECT 1 FROM telegram_outbox other WHERE other.transaction_id=$4 AND other.revision=$2 AND other.id<>$1) RETURNING id`,
    [question.id, current.revision, JSON.stringify(after), current.id],
  );
  return changed.rows.length > 0;
}

export async function activeQuestionForPayment(
  tx: Executor,
  current: Row,
): Promise<string | undefined> {
  const rows = (
    await tx.query(
      "SELECT * FROM telegram_outbox WHERE transaction_id=$1 AND state IN ('queued','sending','sent','uncertain') ORDER BY created_at DESC,id",
      [current.id],
    )
  ).rows;
  for (const question of rows) {
    if (await rebasePendingQuestion(tx, question, current))
      return String(question.id);
  }
  return undefined;
}

export class TelegramClarifications {
  private readonly settings: TelegramConfig;
  constructor(
    readonly db: Database,
    settings: TelegramConfig,
    readonly transport: TelegramTransport,
  ) {
    this.settings = validateTelegramConfig(settings);
  }
  async queue(
    transactionId: string,
    revision: number,
    prompt: string,
    actor: Owner,
  ): Promise<string> {
    owner(actor);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid_revision');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000)
      throw new Error('invalid_prompt');
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          transactionId,
        ])
      ).rows[0];
      if (!row || row.owner !== actor) throw new Error('not_found');
      if (Number(row.revision) !== revision) throw new Error('stale_revision');
      const active = await activeQuestionForPayment(tx, row);
      if (active) return active;
      const result = await tx.query(
        `INSERT INTO telegram_outbox(id,transaction_id,revision,owner,chat_id,prompt,state,payment_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7) ON CONFLICT(transaction_id,revision) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          transactionId,
          revision,
          actor,
          this.settings.chatId,
          prompt,
          JSON.stringify(paymentSnapshot(row)),
        ],
      );
      return String(
        result.rows[0]?.id ??
          (
            await tx.query(
              'SELECT id FROM telegram_outbox WHERE transaction_id=$1 AND revision=$2',
              [transactionId, revision],
            )
          ).rows[0]!.id,
      );
    });
  }
  async queueReport(snapshotId: string, actor: Owner): Promise<string> {
    owner(actor);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT owner,content,version FROM report_snapshots WHERE id=$1',
          [snapshotId],
        )
      ).rows[0];
      if (!row || (row.owner !== actor && row.owner !== 'all'))
        throw new Error('not_found');
      const report = row.content as ReportContent;
      if (report.owner !== row.owner) throw new Error('invalid_report_owner');
      const text = reportText(report, Number(row.version));
      const result = await tx.query(
        `INSERT INTO report_delivery(id,report_id,actor,chat_id,text,state)
        VALUES($1,$2,$3,$4,$5,'queued') ON CONFLICT(report_id) DO NOTHING RETURNING id`,
        [randomUUID(), snapshotId, actor, this.settings.chatId, text],
      );
      return String(
        result.rows[0]?.id ??
          (
            await tx.query(
              'SELECT id FROM report_delivery WHERE report_id=$1',
              [snapshotId],
            )
          ).rows[0]!.id,
      );
    });
  }
  async dispatchReportOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const row = await this.db.transaction(async (tx) => {
      const item = (
        await tx.query(
          `SELECT * FROM report_delivery WHERE state='queued' AND chat_id=$1 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!item) return null;
      await tx.query(
        "UPDATE report_delivery SET state='sending',lease_until=now()+interval '60 seconds' WHERE id=$1",
        [item.id],
      );
      return item;
    });
    if (!row) return 'idle';
    try {
      const sent = await this.transport.send(
        String(row.chat_id),
        String(row.text),
        { forceReply: false },
      );
      if (!positiveId(sent.messageId)) throw new TelegramError('uncertain');
      const saved = await this.db.query(
        "UPDATE report_delivery SET state='sent',message_id=$2,lease_until=NULL WHERE id=$1 AND state='sending' AND lease_until>=now() RETURNING id",
        [row.id, sent.messageId],
      );
      if (!saved.rows.length) throw new TelegramError('uncertain');
      return 'sent';
    } catch {
      await this.db.query(
        "UPDATE report_delivery SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
        [row.id],
      );
      return 'uncertain';
    }
  }
  async recoverExpired(): Promise<void> {
    await this.db.query(
      "UPDATE report_delivery SET state='uncertain',lease_until=NULL WHERE state='sending' AND lease_until<now()",
    );
    await this.db.query(
      "UPDATE telegram_outbox SET state='uncertain',lease_until=NULL WHERE state='sending' AND lease_until<now()",
    );
  }
  async dispatchOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const item = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT o.* FROM telegram_outbox o WHERE o.state='queued' AND o.chat_id=$1 ORDER BY o.created_at,o.id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!row) return null;
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.transaction_id,
        ])
      ).rows[0];
      if (
        !current ||
        current.owner !== row.owner ||
        !(await rebasePendingQuestion(tx, row, current))
      ) {
        await tx.query(
          "UPDATE telegram_outbox SET state='uncertain' WHERE id=$1",
          [row.id],
        );
        return null;
      }
      await tx.query(
        "UPDATE telegram_outbox SET state='sending',lease_until=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!item) return 'idle';
    try {
      const result = await this.transport.send(
        String(item.chat_id),
        String(item.prompt),
      );
      if (!positiveId(result.messageId)) throw new TelegramError('uncertain');
      const saved = await this.db.query(
        "UPDATE telegram_outbox SET state='sent',message_id=$2,lease_until=NULL WHERE id=$1 AND state='sending' AND lease_until>=now() RETURNING id",
        [item.id, result.messageId],
      );
      if (!saved.rows.length) {
        await this.db.query(
          "UPDATE telegram_outbox SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
          [item.id],
        );
        return 'uncertain';
      }
      return 'sent';
    } catch {
      await this.db.query(
        "UPDATE telegram_outbox SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
        [item.id],
      );
      return 'uncertain';
    }
  }
  async receive(
    raw: unknown,
  ): Promise<'accepted' | 'ignored' | 'duplicate' | 'stale'> {
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
      return 'ignored';
    const actor = (['rodion', 'katya'] as const).find(
      (key) => this.settings.userIds[key] === String(from.id),
    );
    if (!actor) return 'ignored';
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',
        [update!.update_id],
      );
      if (!inserted.rows.length) return 'duplicate';
      // Whatever happens below, say so on the row: an answer that reaches
      // nothing must not disappear leaving only its update number behind.
      const settle = async (
        outcome: 'accepted' | 'ignored' | 'stale',
        detail: string,
      ) => {
        await tx.query(
          'UPDATE telegram_updates SET outcome=$2,detail=$3 WHERE update_id=$1',
          [update!.update_id, outcome, detail],
        );
        return outcome;
      };
      const row = (
        await tx.query(
          "SELECT * FROM telegram_outbox WHERE chat_id=$1 AND message_id=$2 AND owner=$3 AND state='sent'",
          [this.settings.chatId, reply!.message_id, actor],
        )
      ).rows[0];
      if (!row) {
        const addressed = (
          await tx.query(
            "SELECT owner FROM telegram_outbox WHERE chat_id=$1 AND message_id=$2 AND state='sent'",
            [this.settings.chatId, reply!.message_id],
          )
        ).rows[0];
        return settle(
          'ignored',
          addressed
            ? `${actor} answered a question addressed to ${String(addressed.owner)}`
            : 'the message replied to is not an open question',
        );
      }
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.transaction_id,
        ])
      ).rows[0];
      if (!current) return settle('stale', 'the payment no longer exists');
      if (current.owner !== actor)
        return settle('stale', 'the payment belongs to the other member');
      if (!(await rebasePendingQuestion(tx, row, current)))
        return settle(
          'stale',
          `the payment moved on from revision ${String(row.revision)} to ${String(current.revision)} before the answer arrived`,
        );
      await tx.query(
        'INSERT INTO telegram_proposal_inputs(id,outbox_id,update_id,owner,input_text,message_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          row.id,
          update!.update_id,
          actor,
          message!.text,
          positiveId(message?.message_id) ? message!.message_id : null,
        ],
      );
      return settle(
        'accepted',
        `linked to payment ${String(row.transaction_id)}`,
      );
    });
  }
  async history(actor: Owner): Promise<Array<Record<string, unknown>>> {
    owner(actor);
    return (
      await this.db.query(
        `SELECT p.id,p.input_text,p.status,p.created_at,o.transaction_id,o.revision,
          w.state AS workflow_state,t.description AS transaction_description
        FROM telegram_proposal_inputs p
        JOIN telegram_outbox o ON o.id=p.outbox_id
        JOIN transactions t ON t.id=o.transaction_id
        LEFT JOIN telegram_reply_workflows w ON w.input_id=p.id AND w.owner=p.owner
        WHERE p.owner=$1 AND o.owner=$1 AND t.owner=$1
        ORDER BY p.created_at DESC,p.id DESC`,
        [actor],
      )
    ).rows;
  }
  async pending(actor: Owner): Promise<Array<Record<string, unknown>>> {
    owner(actor);
    return (
      await this.db.query(
        `SELECT p.id,p.input_text,p.status,p.created_at,o.transaction_id,o.revision
      FROM telegram_proposal_inputs p JOIN telegram_outbox o ON o.id=p.outbox_id WHERE p.owner=$1 AND p.status='pending' ORDER BY p.created_at,p.id`,
        [actor],
      )
    ).rows;
  }
}
