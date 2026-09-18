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
/** Reactions the bot is allowed to leave. Telegram accepts only a fixed set
 * of emoji from a bot and answers REACTION_INVALID to anything else; 🙌 was
 * in this list until 18 September 2026 and never once landed. */
export type TelegramReaction = '👍' | '👀' | null;
/**
 * Where a household member's name sits in a message, so Telegram renders that
 * name as a mention: tappable, and a notification for the person named rather
 * than a word they have to notice. Offsets and lengths are UTF-16 code units,
 * which is exactly what `String.prototype.length` counts.
 */
export interface TelegramMention {
  offset: number;
  length: number;
  userId: string;
}
export interface TelegramSendOptions {
  forceReply?: boolean;
  mentions?: TelegramMention[];
}
export interface TelegramTransport {
  send(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
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
    options?: { mentions?: TelegramMention[] },
  ): Promise<{ messageId: number }>;
}
/** How the bot writes each member's name when it speaks to them. */
export const ownerNames: Record<Owner, string> = {
  rodion: 'Rodion',
  katya: 'Katya',
};
/**
 * The mentions for a message that addresses members by name. Each name is
 * looked for once, in the order given, starting after the previous one: the
 * quoted bank description sits at the end of these messages and may itself
 * read `Sent money to Rodion Salnik`, which is the bank naming a payee and not
 * the bot addressing anyone. A name the message does not contain is left
 * untagged rather than guessed at.
 */
export function addressMentions(
  text: string,
  addressees: Owner[],
  userIds: Record<Owner, string>,
): TelegramMention[] {
  const mentions: TelegramMention[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (const addressee of addressees) {
    if (!Object.prototype.hasOwnProperty.call(ownerNames, addressee)) continue;
    const name = ownerNames[addressee];
    const userId = userIds?.[addressee];
    // Some messages lead with the display name and some with the stored key
    // (`rodion:`); both spell the same person, so either one is the address.
    const offset = haystack.indexOf(name.toLowerCase(), from);
    if (offset < 0 || !userId) continue;
    mentions.push({ offset, length: name.length, userId });
    from = offset + name.length;
  }
  return mentions;
}
/**
 * Every member named by a sentence of the bot's own, in the order it names
 * them. Only the fixed notes the bot writes go through here — they quote no
 * bank description — so a name in one is always a person being spoken about.
 */
export function namedMentions(
  text: string,
  userIds: Record<Owner, string>,
): TelegramMention[] {
  const lowered = text.toLowerCase();
  const named = (['rodion', 'katya'] as const)
    .map((key) => ({
      key,
      offset: lowered.indexOf(ownerNames[key].toLowerCase()),
    }))
    .filter((item) => item.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  return addressMentions(
    text,
    named.map((item) => item.key),
    userIds,
  );
}
export class TelegramError extends Error {
  constructor(readonly code: 'configuration' | 'uncertain') {
    super(`telegram_${code}`);
  }
}
/**
 * Telegram answered 400: it refused the request rather than acting on it, so
 * the message was certainly not delivered — unlike a timeout, where it may
 * have been. Internal, and never the failure a caller sees: every send still
 * reports `uncertain`, which is the only state the outbox knows.
 */
class TelegramRejection extends Error {}
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
      throw response.status === 400
        ? new TelegramRejection()
        : new TelegramError('uncertain');
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
  // A mention Telegram will accept from a bot: `text_mention` carries the
  // numeric user id, so it tags a member who has no @username and never breaks
  // when someone changes theirs. Sent as entities rather than HTML so the
  // message stays plain text — a bank description full of `<` and `&` needs no
  // escaping and cannot smuggle markup into what the household reads. An
  // entity reaching past the end of the text makes Telegram reject the whole
  // message, so a range that does not fit is dropped and the message still goes.
  const mentionEntities = (
    text: string,
    mentions: TelegramMention[] | undefined,
  ): Array<Record<string, unknown>> => {
    const entities: Array<Record<string, unknown>> = [];
    for (const mention of mentions ?? []) {
      const id = Number(mention?.userId);
      if (
        !Number.isSafeInteger(mention?.offset) ||
        mention.offset < 0 ||
        !Number.isSafeInteger(mention?.length) ||
        mention.length < 1 ||
        mention.offset + mention.length > text.length ||
        !Number.isSafeInteger(id) ||
        id <= 0
      )
        continue;
      entities.push({
        type: 'text_mention',
        offset: mention.offset,
        length: mention.length,
        user: {
          id,
          is_bot: false,
          first_name: text.slice(
            mention.offset,
            mention.offset + mention.length,
          ),
        },
      });
    }
    return entities;
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
      const entities = mentionEntities(text, options?.mentions);
      const payload = (tagged: boolean) => ({
        chat_id: chatId,
        text,
        ...(tagged && entities.length ? { entities } : {}),
        ...(options?.forceReply === false
          ? {}
          : { reply_markup: { force_reply: true, selective: false } }),
      });
      try {
        try {
          return sentMessage(await call('sendMessage', payload(true)), chatId);
        } catch (error) {
          // The mention is the part Telegram can refuse — an id it cannot
          // resolve to someone it has seen — and the message matters more than
          // the tag. A refusal delivered nothing, so saying it again untagged
          // cannot duplicate anything, and it is said once.
          if (!entities.length || !(error instanceof TelegramRejection))
            throw error;
          return sentMessage(await call('sendMessage', payload(false)), chatId);
        }
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
    async reply(chatId, messageId, text, options) {
      const entities = mentionEntities(text, options?.mentions);
      // A plain reply: no force_reply keyboard, so it never opens an input prompt.
      const payload = (tagged: boolean) => ({
        chat_id: chatId,
        text,
        ...(tagged && entities.length ? { entities } : {}),
        reply_parameters: {
          message_id: messageId,
          allow_sending_without_reply: true,
        },
      });
      try {
        try {
          return sentMessage(await call('sendMessage', payload(true)), chatId);
        } catch (error) {
          if (!entities.length || !(error instanceof TelegramRejection))
            throw error;
          return sentMessage(await call('sendMessage', payload(false)), chatId);
        }
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
  // `owner` is whose payment the question was about; `answered_by` is who
  // actually typed the answer. The chat is shared and either member may answer
  // any question in it, because either of them may genuinely know what a
  // payment was for — but which of them did is worth keeping. Rows written
  // before this have none and are read as having been answered by the owner.
  await tx.query(
    `ALTER TABLE telegram_proposal_inputs ADD COLUMN IF NOT EXISTS answered_by text
     CHECK(answered_by IN ('rodion','katya'))`,
  );
  // The owner's own message, so the bot can react to it and answer it in
  // place. Rows written before this have none, and are answered without a
  // reply target rather than being repaired.
  await tx.query(
    'ALTER TABLE telegram_proposal_inputs ADD COLUMN IF NOT EXISTS message_id bigint',
  );
  // A loose note to a household member, answering their own message: that an
  // answer reached nothing and why. Until 17 September 2026 a lost answer was
  // recorded and logged but never said in the chat, because the outbox holds
  // a question about a payment and nothing else.
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_notes (
    id uuid PRIMARY KEY,chat_id text NOT NULL,message_id bigint NOT NULL,text text NOT NULL,
    state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain')),
    lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
    reply_message_id bigint
  )`);
}

/** Where a payment can be opened and decided; nothing when no origin is configured. */
export function reviewLink(
  settings: Pick<TelegramConfig, 'publicOrigin'>,
  transactionId: string,
): string {
  return settings.publicOrigin
    ? `\n${settings.publicOrigin}/review?id=${encodeURIComponent(transactionId)}`
    : '';
}

/** The detail recorded for a plain message in the chat, which is the
 * members' own conversation rather than an answer that reached nothing. */
export const NOT_A_REPLY = 'the message is not a reply to a question';

/** How a payment's account reads in a chat message: the household's own label,
 * with the bank named when the label alone does not name it. */
export function accountLine(
  source: unknown,
  label: unknown,
): string | undefined {
  if (typeof label !== 'string' || !label.trim()) return undefined;
  const name = label
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 80);
  if (source === 'monobank' && !/mono/i.test(name)) return `${name} · Monobank`;
  if (source === 'manual_cash') return `${name} · cash`;
  return name;
}

/** Queue a note answering a household member's own message. Written inside the
 * caller's transaction, so it exists exactly when the outcome it explains does. */
export async function queueTelegramNote(
  tx: Executor,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  if (!positiveId(messageId)) return;
  await tx.query(
    "INSERT INTO telegram_notes(id,chat_id,message_id,text,state) VALUES($1,$2,$3,$4,'queued')",
    [randomUUID(), chatId, messageId, text.slice(0, 4000)],
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
  /** `payer` is the member whose account the payment sits on and who the
   * question is addressed to; either member may send it and either may answer
   * (migration 44), and the reply records which of them did. */
  async queue(
    transactionId: string,
    revision: number,
    prompt: string,
    payer: Owner,
  ): Promise<string> {
    owner(payer);
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
      if (!row || row.owner !== payer) throw new Error('not_found');
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
          payer,
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
      // The prompt opens with the owner's name because the question is for
      // them; sent as a mention it also reaches them as a notification.
      const prompt = String(item.prompt);
      const result = await this.transport.send(String(item.chat_id), prompt, {
        mentions: addressMentions(
          prompt,
          [owner(item.owner)],
          this.settings.userIds,
        ),
      });
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
    return (await this.receiveDetailed(raw)).outcome;
  }
  /**
   * Consume one message a household member sent the shared chat. Every such
   * message leaves a row in telegram_updates saying what became of it, and
   * one that answered the bot without reaching a question is answered back
   * with why, so a lost answer is never silent again. A message that is not
   * addressed to us at all — another chat, a stranger, a bot, no text — is
   * ignored without a trace.
   */
  async receiveDetailed(raw: unknown): Promise<{
    outcome: 'accepted' | 'ignored' | 'duplicate' | 'stale';
    detail?: string;
  }> {
    const update = record(raw),
      message = record(update?.message),
      chat = record(message?.chat),
      from = record(message?.from),
      reply = record(message?.reply_to_message),
      repliedTo = record(reply?.from);
    if (
      !Number.isSafeInteger(update?.update_id) ||
      Number(update?.update_id) < 0 ||
      !Number.isSafeInteger(chat?.id) ||
      String(chat?.id) !== this.settings.chatId ||
      !positiveId(from?.id) ||
      from?.is_bot === true ||
      typeof message?.text !== 'string' ||
      !message.text.trim() ||
      message.text.length > 4000
    )
      return { outcome: 'ignored' };
    const actor = (['rodion', 'katya'] as const).find(
      (key) => this.settings.userIds[key] === String(from.id),
    );
    if (!actor) return { outcome: 'ignored' };
    const ownMessage = positiveId(message?.message_id)
      ? message!.message_id
      : null;
    // Only a reply to one of our own messages was meant for us; a reply to the
    // other member, or a plain message in the chat, is their conversation.
    const answeredUs =
      positiveId(reply?.message_id) && repliedTo?.is_bot === true;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',
        [update!.update_id],
      );
      if (!inserted.rows.length) return { outcome: 'duplicate' as const };
      // Whatever happens below, say so on the row: an answer that reaches
      // nothing must not disappear leaving only its update number behind.
      const settle = async (
        outcome: 'accepted' | 'ignored' | 'stale',
        detail: string,
        note?: string,
      ) => {
        await tx.query(
          'UPDATE telegram_updates SET outcome=$2,detail=$3 WHERE update_id=$1',
          [update!.update_id, outcome, detail],
        );
        if (note && ownMessage)
          await queueTelegramNote(tx, this.settings.chatId, ownMessage, note);
        return { outcome, detail };
      };
      if (!positiveId(reply?.message_id)) return settle('ignored', NOT_A_REPLY);
      // Any member of the household may answer any question in the shared chat;
      // the question is addressed to the card's owner but the other one may
      // well know what the payment was. Who answered is recorded rather than
      // being a reason to throw the answer away.
      const row = (
        await tx.query(
          "SELECT * FROM telegram_outbox WHERE chat_id=$1 AND message_id=$2 AND state='sent'",
          [this.settings.chatId, reply!.message_id],
        )
      ).rows[0];
      if (!row)
        return this.unmatchedReply(
          tx,
          settle,
          reply!.message_id,
          actor,
          answeredUs,
        );
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.transaction_id,
        ])
      ).rows[0];
      const movedOn = `This payment changed since I asked, so your answer was not applied. Open it and decide there.${reviewLink(this.settings, String(row.transaction_id))}`;
      if (!current)
        return settle(
          'stale',
          'the payment no longer exists',
          'This payment is no longer in the ledger, so your answer was not applied.',
        );
      if (current.owner !== row.owner)
        return settle(
          'stale',
          'the question no longer matches the payment',
          movedOn,
        );
      if (!(await rebasePendingQuestion(tx, row, current)))
        return settle(
          'stale',
          `the payment moved on from revision ${String(row.revision)} to ${String(current.revision)} before the answer arrived`,
          movedOn,
        );
      await tx.query(
        'INSERT INTO telegram_proposal_inputs(id,outbox_id,update_id,owner,answered_by,input_text,message_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          row.id,
          update!.update_id,
          String(row.owner),
          actor,
          message!.text,
          ownMessage,
        ],
      );
      return settle(
        'accepted',
        `${actor} answered for ${String(row.owner)}; linked to payment ${String(row.transaction_id)}`,
      );
    });
  }
  /**
   * A reply to one of our messages that is not an open question. What it was
   * decides what is said: a report or an earlier note draws nothing, a refund
   * question addressed to the other member or already closed says so, and
   * anything else — a receipt, a closed question — is told it reached nothing.
   */
  private async unmatchedReply(
    tx: Executor,
    settle: (
      outcome: 'accepted' | 'ignored' | 'stale',
      detail: string,
      note?: string,
    ) => Promise<{
      outcome: 'accepted' | 'ignored' | 'stale';
      detail: string;
    }>,
    repliedTo: number,
    actor: Owner,
    answeredUs: boolean,
  ) {
    if (!answeredUs)
      return settle(
        'ignored',
        'the message replied to is not an open question',
      );
    const args = [this.settings.chatId, repliedTo];
    if (
      (
        await tx.query(
          'SELECT 1 FROM report_delivery WHERE chat_id=$1 AND message_id=$2',
          args,
        )
      ).rows.length
    )
      return settle('ignored', 'the message replied to is a report');
    if (
      (
        await tx.query(
          'SELECT 1 FROM telegram_notes WHERE chat_id=$1 AND reply_message_id=$2',
          args,
        )
      ).rows.length
    )
      return settle('ignored', 'the message replied to is a note');
    const refund = (
      await tx.query(
        'SELECT owner,state FROM refund_questions WHERE chat_id=$1 AND message_id=$2',
        args,
      )
    ).rows[0];
    if (refund && refund.state === 'sent' && refund.owner !== actor)
      return settle(
        'ignored',
        `the message replied to is a refund question addressed to ${String(refund.owner)}`,
        `This refund question is addressed to ${ownerNames[refund.owner as Owner]}, and only they can answer it.`,
      );
    if (refund)
      return settle(
        'ignored',
        'the message replied to is a refund question that is no longer open',
        'This question is no longer open, so nothing was saved. Open the payment in Private Finances if it needs changing.',
      );
    return settle(
      'ignored',
      'the message replied to is not an open question',
      'I could not link this to an open question about a payment, so nothing was saved. Reply directly to the question about that payment, or decide it in Private Finances.',
    );
  }
  /** Send one queued note: a 👀 on the member's message, then the answer under
   * it. The reaction is a courtesy and never blocks the note. */
  async dispatchNoteOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const item = await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE telegram_notes SET state='uncertain',lease_until=NULL WHERE chat_id=$1 AND state='sending' AND lease_until<now()",
        [this.settings.chatId],
      );
      const row = (
        await tx.query(
          "SELECT * FROM telegram_notes WHERE chat_id=$1 AND state='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
          [this.settings.chatId],
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        "UPDATE telegram_notes SET state='sending',lease_until=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!item) return 'idle';
    await this.transport
      .react(this.settings.chatId, Number(item.message_id), '👀')
      .catch(() => undefined);
    try {
      // A note that says whose question it is tags them, so the member who has
      // to answer hears about it rather than only the one who read the note.
      const text = String(item.text);
      const sent = await this.transport.reply(
        this.settings.chatId,
        Number(item.message_id),
        text,
        { mentions: namedMentions(text, this.settings.userIds) },
      );
      // The note's own message is remembered so that a reply to it is
      // recognised as such rather than answered with another note.
      const saved = await this.db.query(
        "UPDATE telegram_notes SET state='sent',lease_until=NULL,reply_message_id=$2 WHERE id=$1 AND state='sending' AND lease_until>=now() RETURNING id",
        [item.id, positiveId(sent.messageId) ? sent.messageId : null],
      );
      if (saved.rows.length) return 'sent';
    } catch {
      /* An uncertain note must not be repeated automatically. */
    }
    await this.db.query(
      "UPDATE telegram_notes SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
      [item.id],
    );
    return 'uncertain';
  }
  async history(actor: Owner): Promise<Array<Record<string, unknown>>> {
    owner(actor);
    return (
      await this.db.query(
        `SELECT p.id,p.input_text,p.status,p.created_at,o.transaction_id,o.revision,
          coalesce(p.answered_by,p.owner) AS answered_by,
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
