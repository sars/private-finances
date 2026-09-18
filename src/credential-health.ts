import { randomUUID } from 'node:crypto';
import type { Database, Executor } from './database.js';
import type { Owner } from './domain.js';
import { namedMentions, type TelegramTransport } from './telegram.js';

const DAY = 86400000;
/**
 * The credentials whose expiry this application watches.
 *
 * Two so far, and they are not alike. The OpenAI key has a date the owner was
 * given and no confirmed instant behind it, so its date-only setting is read
 * first. The IBKR Flex token states the second it dies — Client Portal prints
 * it when the token is generated — so its instant is read first and the
 * date-only setting is the fallback for a token whose exact time was never
 * written down. Each carries its own renewal sentence because "renew it on the
 * server" is no use to somebody who has to find the Flex Web Service page.
 */
export const TRACKED_CREDENTIALS = [
  {
    credential: 'openai_api_key',
    label: 'OpenAI API key',
    envKeys: ['OPENAI_API_KEY_EXPIRES_ON', 'OPENAI_API_KEY_EXPIRES_AT'],
    renewal: 'Renew or replace it on the server and update its expiry setting.',
  },
  {
    credential: 'ibkr_flex_token',
    label: 'IBKR Flex token',
    envKeys: ['IBKR_FLEX_TOKEN_EXPIRES_AT', 'IBKR_FLEX_TOKEN_EXPIRES_ON'],
    renewal:
      "Generate a new token in Client Portal → Performance & Reports → Flex Queries → Flex Web Service Configuration, save it to the server's credentials directory as ibkr-flex-token, and update IBKR_FLEX_TOKEN_EXPIRES_AT.",
  },
] as const;
export type TrackedCredential =
  (typeof TRACKED_CREDENTIALS)[number]['credential'];
export type CredentialExpiryEnv = Partial<
  Record<(typeof TRACKED_CREDENTIALS)[number]['envKeys'][number], string>
>;
function descriptorFor(credential: TrackedCredential) {
  return TRACKED_CREDENTIALS.find((c) => c.credential === credential)!;
}
/** The human name for a credential, for operations UI. */
export function credentialLabel(credential: TrackedCredential): string {
  return descriptorFor(credential).label;
}
export type CredentialHealth = {
  credential: TrackedCredential;
  label: string;
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
/** Only expiry metadata enters this module. Never supply the credential itself.
 * A date-only value never implies an exact credential validity instant.
 */
export function credentialExpiryHealth(
  credential: TrackedCredential,
  rawExpiry: string | undefined,
  now = new Date(),
  timeZone = 'Europe/Riga',
): CredentialHealth {
  if (!Number.isFinite(now.getTime()))
    throw new Error('invalid_credential_health_time');
  const today = calendarDay(now, timeZone);
  const base: CredentialHealth = {
    credential,
    label: credentialLabel(credential),
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
/** The OpenAI key's parser, kept under its own name for existing callers. */
export function openAiCredentialHealth(
  rawExpiry: string | undefined,
  now = new Date(),
  timeZone = 'Europe/Riga',
): CredentialHealth {
  return credentialExpiryHealth('openai_api_key', rawExpiry, now, timeZone);
}
/** The expiry metadata configured for one credential, in its own precedence. */
export function credentialExpiryFromEnv(
  credential: TrackedCredential,
  env: CredentialExpiryEnv,
): string | undefined {
  for (const key of descriptorFor(credential).envKeys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}
/** The OpenAI key's health alone; `credentialsHealthFromEnv` covers them all. */
export function credentialHealthFromEnv(
  env: CredentialExpiryEnv,
  now = new Date(),
): CredentialHealth {
  return credentialExpiryHealth(
    'openai_api_key',
    credentialExpiryFromEnv('openai_api_key', env),
    now,
  );
}
/**
 * Every tracked credential, configured or not.
 *
 * A credential with no expiry setting is reported as `unknown_expiry` rather
 * than left out: operations should see that this application is watching the
 * IBKR Flex token and has been told nothing about when it dies. Omitting it
 * would read as "nothing to worry about", which is the opposite of the truth.
 */
export function credentialsHealthFromEnv(
  env: CredentialExpiryEnv,
  now = new Date(),
): CredentialHealth[] {
  return TRACKED_CREDENTIALS.map((c) =>
    credentialExpiryHealth(
      c.credential,
      credentialExpiryFromEnv(c.credential, env),
      now,
    ),
  );
}
function reminderText(health: CredentialHealth): string {
  const when = health.expiresOn
    ? `${health.expiresOn} (Europe/Riga date; exact validity time unknown)`
    : health.expiresAt;
  return `The ${health.label} reaches its configured expiry within ${health.warningDays} calendar day(s): ${when}. ${descriptorFor(health.credential).renewal}`;
}

export async function initializeCredentialHealth(db: Executor): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS credential_reminders (
    id uuid PRIMARY KEY, credential text NOT NULL CHECK(credential IN ('openai_api_key','bank_consent','ibkr_flex_token')),
    expiry_key text NOT NULL, warning_days integer NOT NULL CHECK(warning_days IN (5,2,1)),
    message text NOT NULL,
    chat_id text NOT NULL, state text NOT NULL CHECK(state IN ('queued','sending','sent','uncertain','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, message_id bigint,
    UNIQUE(credential,expiry_key,warning_days,chat_id)
  )`);
  // A bank approval expires too, and when it does the imports simply stop. The
  // table was written for one credential and two-to-five days' notice; it now
  // carries bank approvals as well, and a notice on the day itself, because an
  // approval that has already lapsed is the case worth saying out loud. The
  // IBKR Flex token joined them: it expires yearly, and an expired one stops
  // the holdings snapshot as quietly as a lapsed approval stops the imports.
  await db.query(
    'ALTER TABLE credential_reminders DROP CONSTRAINT IF EXISTS credential_reminders_credential_check',
  );
  await db.query(
    `ALTER TABLE credential_reminders ADD CONSTRAINT credential_reminders_credential_check
     CHECK(credential IN ('openai_api_key','bank_consent','ibkr_flex_token'))`,
  );
  await db.query(
    'ALTER TABLE credential_reminders DROP CONSTRAINT IF EXISTS credential_reminders_warning_days_check',
  );
  await db.query(
    `ALTER TABLE credential_reminders ADD CONSTRAINT credential_reminders_warning_days_check
     CHECK(warning_days IN (5,2,1,0))`,
  );
}

export type BankConsent = {
  owner: string;
  bank: string;
  country: string;
  expiresAt: string;
};
export type BankConsentNotice = BankConsent & {
  daysRemaining: number;
  warningDays: 5 | 2 | 1 | 0 | null;
  expired: boolean;
};

/**
 * How much notice a bank approval deserves.
 *
 * The provider grants these for days rather than months — ten for Enable
 * Banking — so the ladder starts at five days and ends at the day the approval
 * lapses. Zero is not a missed warning: it is the one that matters, because
 * from then on nothing imports and nothing else says so.
 */
export function bankConsentNotice(
  consent: BankConsent,
  now = new Date(),
  timeZone = 'Europe/Riga',
): BankConsentNotice {
  if (!Number.isFinite(now.getTime()))
    throw new Error('invalid_credential_health_time');
  if (!Number.isFinite(Date.parse(consent.expiresAt)))
    throw new Error('invalid_consent_expiry');
  const expiryDay = calendarDay(new Date(consent.expiresAt), timeZone);
  const daysRemaining =
    (Date.parse(expiryDay) - Date.parse(calendarDay(now, timeZone))) / DAY;
  const expired = Date.parse(consent.expiresAt) <= now.getTime();
  const warningDays = expired
    ? 0
    : daysRemaining <= 0
      ? 0
      : daysRemaining <= 1
        ? 1
        : daysRemaining <= 2
          ? 2
          : daysRemaining <= 5
            ? 5
            : null;
  return { ...consent, daysRemaining, warningDays, expired };
}

function consentText(notice: BankConsentNotice): string {
  const when = new Date(notice.expiresAt)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  const bank = `${notice.bank} (${notice.country}), ${notice.owner}`;
  return notice.expired
    ? `⚠️ ${bank}: the bank approval expired on ${when} UTC. Nothing is importing from this bank until you approve it again on the Bank connections page.`
    : notice.warningDays === 0
      ? `⚠️ ${bank}: the bank approval expires today, ${when} UTC. Approve it again on the Bank connections page or the imports stop.`
      : `${bank}: the bank approval expires in ${notice.warningDays} day(s), on ${when} UTC. Approve it again on the Bank connections page to keep the imports running.`;
}

/** Call only with the application's already verified Telegram group binding. */
export class CredentialReminders {
  constructor(
    readonly db: Database,
    readonly chatId: string,
    readonly transport: TelegramTransport,
    /**
     * Who to tag when a notice names a member. A bank approval is renewed by
     * the member whose approval it is, so the notice reaches them rather than
     * waiting to be noticed. Absent, the notice still goes out, untagged.
     */
    readonly userIds?: Record<Owner, string>,
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
    credential: TrackedCredential = 'openai_api_key',
  ): Promise<CredentialHealth> {
    const health = credentialExpiryHealth(credential, rawExpiry, now);
    const expiryKey = health.expiresOn
      ? `on:${health.expiresOn}`
      : health.expiresAt
        ? `at:${health.expiresAt}`
        : null;
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482400)');
      // Replacement/invalid metadata or a newer threshold retires unsent
      // notices — for this credential only, so a second credential's series
      // never cancels the first's.
      await tx.query(
        `UPDATE credential_reminders SET state='cancelled' WHERE credential=$4 AND chat_id=$1 AND state='queued'
        AND (expiry_key IS DISTINCT FROM $2::text OR warning_days IS DISTINCT FROM $3::integer)`,
        [this.chatId, expiryKey, health.warningDays, credential],
      );
      if (expiryKey && health.warningDays !== null && health.warningDays > 0) {
        await tx.query(
          `INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,chat_id,message,state) VALUES($1,$6,$2,$3,$4,$5,'queued')
          ON CONFLICT(credential,expiry_key,warning_days,chat_id) DO NOTHING`,
          [
            randomUUID(),
            expiryKey,
            health.warningDays,
            this.chatId,
            reminderText(health),
            credential,
          ],
        );
      }
    });
    return health;
  }
  /** Every tracked credential, each with its own warning series. */
  async enqueueConfigured(
    env: CredentialExpiryEnv,
    now = new Date(),
  ): Promise<CredentialHealth[]> {
    const health: CredentialHealth[] = [];
    for (const c of TRACKED_CREDENTIALS)
      health.push(
        await this.enqueue(
          credentialExpiryFromEnv(c.credential, env),
          now,
          c.credential,
        ),
      );
    return health;
  }
  /**
   * Queue a notice for every bank approval nearing its end, or already past it.
   *
   * The key carries the owner and the bank as well as the expiry, so renewing
   * an approval retires the unsent notices for the old one and a second bank
   * never silently replaces the first.
   */
  async enqueueBankConsents(now = new Date()): Promise<BankConsentNotice[]> {
    const { rows } = await this.db.query(
      `SELECT owner, bank, country, expires_at FROM bank_consents
       WHERE status = 'authorized' ORDER BY owner, bank`,
    );
    const notices: BankConsentNotice[] = [];
    for (const row of rows) {
      const notice = bankConsentNotice(
        {
          owner: String(row.owner),
          bank: String(row.bank),
          country: String(row.country),
          expiresAt: new Date(String(row.expires_at)).toISOString(),
        },
        now,
      );
      notices.push(notice);
      const scope = `${notice.owner}:${notice.bank}`;
      const expiryKey = `${scope}:at:${notice.expiresAt}`;
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(7482401)');
        // A renewed approval, or a nearer threshold, retires what was queued
        // for this bank and has not been sent.
        await tx.query(
          `UPDATE credential_reminders SET state='cancelled'
           WHERE credential='bank_consent' AND chat_id=$1 AND state='queued'
             AND expiry_key LIKE $2
             AND (expiry_key IS DISTINCT FROM $3::text
                  OR warning_days IS DISTINCT FROM $4::integer)`,
          [this.chatId, `${scope}:%`, expiryKey, notice.warningDays],
        );
        if (notice.warningDays === null) return;
        await tx.query(
          `INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,chat_id,message,state)
           VALUES($1,'bank_consent',$2,$3,$4,$5,'queued')
           ON CONFLICT(credential,expiry_key,warning_days,chat_id) DO NOTHING`,
          [
            randomUUID(),
            expiryKey,
            notice.warningDays,
            this.chatId,
            consentText(notice),
          ],
        );
      });
    }
    return notices;
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
      const sent = await this.transport.send(this.chatId, text, {
        mentions: this.userIds ? namedMentions(text, this.userIds) : [],
      });
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
