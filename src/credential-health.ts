import { randomUUID } from 'node:crypto';
import type { Database, Executor } from './database.js';
import type { TelegramTransport } from './telegram.js';

const DAY = 86400000;
export type CredentialHealth = {
  credential: 'openai_api_key';
  state:
    | 'unknown_expiry'
    | 'invalid_expiry'
    | 'healthy'
    | 'expiring'
    | 'expires_today'
    | 'expired';
  expiresAt: string | null;
  expiresOn: string | null;
  daysRemaining: number | null;
  warningDays: 5 | 2 | 1 | 0 | null;
};
function calendarDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
/** Only expiry metadata enters this module. Never supply the API key itself.
 * A date-only value never implies an exact credential validity instant.
 */
export function openAiCredentialHealth(
  rawExpiry: string | undefined,
  now = new Date(),
  timeZone = 'Europe/Riga',
): CredentialHealth {
  if (!Number.isFinite(now.getTime()))
    throw new Error('invalid_credential_health_time');
  const today = calendarDay(now, timeZone);
  const base: CredentialHealth = {
    credential: 'openai_api_key',
    state: 'unknown_expiry',
    expiresAt: null,
    expiresOn: null,
    daysRemaining: null,
    warningDays: null,
  };
  if (rawExpiry === undefined || rawExpiry.trim() === '') return base;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry);
  let expiryDay: string;
  let expiresAt: string | null = null;
  if (dateOnly) {
    if (!validDay(rawExpiry)) return { ...base, state: 'invalid_expiry' };
    expiryDay = rawExpiry;
  } else {
    const match =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
        rawExpiry,
      );
    if (
      !match ||
      !validDay(match[1]!) ||
      Number(match[2]) > 23 ||
      Number(match[3]) > 59 ||
      Number(match[4]) > 59 ||
      (match[5] !== 'Z' &&
        (Number(match[5]!.slice(1, 3)) > 23 ||
          Number(match[5]!.slice(4, 6)) > 59)) ||
      !Number.isFinite(Date.parse(rawExpiry))
    )
      return { ...base, state: 'invalid_expiry' };
    expiresAt = new Date(rawExpiry).toISOString();
    expiryDay = calendarDay(new Date(expiresAt), timeZone);
  }
  const daysRemaining = (Date.parse(expiryDay) - Date.parse(today)) / DAY;
  const expired = expiresAt
    ? Date.parse(expiresAt) <= now.getTime()
    : daysRemaining < 0;
  const warningDays =
    expired || daysRemaining === 0
      ? 0
      : daysRemaining <= 1
        ? 1
        : daysRemaining <= 2
          ? 2
          : daysRemaining <= 5
            ? 5
            : null;
  return {
    ...base,
    state: expired
      ? 'expired'
      : daysRemaining === 0
        ? 'expires_today'
        : warningDays === null
          ? 'healthy'
          : 'expiring',
    expiresAt,
    expiresOn: dateOnly ? expiryDay : null,
    daysRemaining,
    warningDays,
  };
}
export function credentialHealthFromEnv(
  env: {
    OPENAI_API_KEY_EXPIRES_ON?: string;
    OPENAI_API_KEY_EXPIRES_AT?: string;
  },
  now = new Date(),
): CredentialHealth {
  return openAiCredentialHealth(
    env.OPENAI_API_KEY_EXPIRES_ON ?? env.OPENAI_API_KEY_EXPIRES_AT,
    now,
  );
}
function reminderText(health: CredentialHealth): string {
  const label = health.expiresOn
    ? `${health.expiresOn} (Europe/Riga date; exact validity time unknown)`
    : health.expiresAt;
  return `The OpenAI API key reaches its configured expiry within ${health.warningDays} calendar day(s): ${label}. Renew or replace it on the server and update its expiry setting.`;
}

export async function initializeCredentialHealth(db: Executor): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS credential_reminders (
    id uuid PRIMARY KEY, credential text NOT NULL CHECK(credential='openai_api_key'),
    expiry_key text NOT NULL, warning_days integer NOT NULL CHECK(warning_days IN (5,2,1)),
    message text NOT NULL,
    chat_id text NOT NULL, state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, message_id bigint,
    UNIQUE(credential,expiry_key,warning_days,chat_id)
  )`);
}

/** Call only with the application's already verified Telegram group binding. */
export class CredentialReminders {
  constructor(
    readonly db: Database,
    readonly chatId: string,
    readonly transport: TelegramTransport,
  ) {
    if (
      !/^-?[1-9]\d{0,15}$/.test(chatId) ||
      !Number.isSafeInteger(Number(chatId))
    )
      throw new Error('invalid_credential_reminder_chat');
  }
  async enqueue(
    rawExpiry: string | undefined,
    now = new Date(),
  ): Promise<CredentialHealth> {
    const health = openAiCredentialHealth(rawExpiry, now);
    const expiryKey = health.expiresOn
      ? `on:${health.expiresOn}`
      : health.expiresAt
        ? `at:${health.expiresAt}`
        : null;
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482400)');
      // Replacement/invalid metadata or a newer threshold retires unsent notices.
      await tx.query(
        `UPDATE credential_reminders SET state='cancelled' WHERE credential='openai_api_key' AND chat_id=$1 AND state='queued'
        AND (expiry_key IS DISTINCT FROM $2::text OR warning_days IS DISTINCT FROM $3::integer)`,
        [this.chatId, expiryKey, health.warningDays],
      );
      if (expiryKey && health.warningDays !== null && health.warningDays > 0) {
        await tx.query(
          `INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,chat_id,message,state) VALUES($1,'openai_api_key',$2,$3,$4,$5,'queued')
          ON CONFLICT(credential,expiry_key,warning_days,chat_id) DO NOTHING`,
          [
            randomUUID(),
            expiryKey,
            health.warningDays,
            this.chatId,
            reminderText(health),
          ],
        );
      }
    });
    return health;
  }
  async dispatchOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const item = await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE credential_reminders SET state='uncertain',lease_until=NULL WHERE chat_id=$1 AND state='sending' AND lease_until<now()",
        [this.chatId],
      );
      const result = await tx.query(
        "SELECT * FROM credential_reminders WHERE chat_id=$1 AND state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        [this.chatId],
      );
      const row = result.rows[0];
      if (!row) return null;
      await tx.query(
        "UPDATE credential_reminders SET state='sending',lease_until=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!item) return 'idle';
    const text = String(item.message);
    try {
      const sent = await this.transport.send(this.chatId, text);
      const saved = await this.db.query(
        "UPDATE credential_reminders SET state='sent',message_id=$2,lease_until=NULL WHERE id=$1 AND state='sending' AND lease_until>=now() RETURNING id",
        [item.id, sent.messageId],
      );
      if (saved.rows.length) return 'sent';
    } catch {
      // A timeout may have delivered the message. Do not retry automatically.
    }
    await this.db.query(
      "UPDATE credential_reminders SET state='uncertain',lease_until=NULL WHERE id=$1 AND state='sending'",
      [item.id],
    );
    return 'uncertain';
  }
  async status(): Promise<Array<{ state: string; count: number }>> {
    const result = await this.db.query(
      'SELECT state,count(*)::integer AS count FROM credential_reminders WHERE chat_id=$1 GROUP BY state ORDER BY state',
      [this.chatId],
    );
    return result.rows.map((r) => ({
      state: String(r.state),
      count: Number(r.count),
    }));
  }
}
