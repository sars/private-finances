import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { migrate, type Database } from './database.js';
import type { Owner } from './domain.js';
import { signJwt } from './connectors/enablebanking.js';
import {
  BANK_NAMES,
  bankSlug,
  isBankName,
  type BankName,
} from './connectors/banks.js';

type Bank = BankName;
export type ConsentCredentials = { applicationId: string; privateKey: string };
/** A single, non-retrying POST. Production transport only permits these AIS endpoints. */
export type ConsentPost = (
  path: '/auth' | '/sessions',
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => Promise<unknown>;
/** A single, non-retrying read of the provider's bank list for one country. */
export type ConsentGet = (
  path: '/aspsps',
  query: { country: string; psu_type: 'personal' },
  headers: Record<string, string>,
) => Promise<unknown>;
const DAY_MS = 86400000;
/** The longest approval the owner may ask for, whatever a bank publishes. */
const MAX_APPROVAL_DAYS = 730;
export class ConsentError extends Error {
  constructor() {
    super('Bank connection could not be completed. Start a new connection.');
    this.name = 'ConsentError';
  }
}
const hash = (state: string) =>
  createHash('sha256').update(state).digest('hex');
function ownerCheck(owner: Owner): void {
  if (!['rodion', 'katya'].includes(owner)) throw new ConsentError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConsentError();
  return value as Record<string, unknown>;
}
const productionPost: ConsentPost = async (path, body, headers) => {
  if (path !== '/auth' && path !== '/sessions') throw new ConsentError();
  const response = await fetch(`https://api.enablebanking.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  return readJson(response);
};
const productionGet: ConsentGet = async (path, query, headers) => {
  if (path !== '/aspsps') throw new ConsentError();
  const url = new URL(`https://api.enablebanking.com${path}`);
  url.searchParams.set('country', query.country);
  url.searchParams.set('psu_type', query.psu_type);
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  return readJson(response);
};
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConsentError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConsentError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new ConsentError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** AIS consent contract: https://enablebanking.com/docs/api/reference/#user-sessions */
export class ConsentService {
  constructor(
    private readonly config: {
      db: Database;
      applicationId?: string;
      privateKey?: string;
      credentialsByOwner?: Partial<Record<Owner, ConsentCredentials>>;
      redirectUrl: string;
      secretDirectory: string;
      post?: ConsentPost;
      get?: ConsentGet;
    },
  ) {
    try {
      const url = new URL(config.redirectUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        !isAbsolute(config.secretDirectory)
      )
        throw new ConsentError();
    } catch {
      throw new ConsentError();
    }
  }
  async initialize(): Promise<void> {
    await migrate(this.config.db);
  }

  private credentials(owner: Owner): ConsentCredentials {
    ownerCheck(owner);
    const credentials =
      this.config.credentialsByOwner?.[owner] ??
      (owner === 'rodion'
        ? {
            applicationId: this.config.applicationId,
            privateKey: this.config.privateKey,
          }
        : undefined);
    if (
      !credentials ||
      typeof credentials.applicationId !== 'string' ||
      !credentials.applicationId.trim() ||
      typeof credentials.privateKey !== 'string' ||
      !credentials.privateKey.trim()
    )
      throw new ConsentError();
    return {
      applicationId: credentials.applicationId,
      privateKey: credentials.privateKey,
    };
  }

  private async post(
    credentials: ConsentCredentials,
    path: '/auth' | '/sessions',
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return object(
      await (this.config.post ?? productionPost)(path, body, {
        Authorization: `Bearer ${signJwt(credentials.applicationId, credentials.privateKey)}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }),
    );
  }
  /**
   * The longest approval, in milliseconds, the provider says this bank
   * accepts. A request past it is refused. The default is this maximum: in
   * September 2026 a ten-day request to LHV ended back on its login page after
   * sign-in, while the provider's own link, asking for the maximum, went
   * through (docs/bank-consent.md).
   */
  private async maximumApproval(
    credentials: ConsentCredentials,
    bank: Bank,
    country: string,
  ): Promise<number> {
    const list = object(
      await (this.config.get ?? productionGet)(
        '/aspsps',
        { country, psu_type: 'personal' },
        {
          Authorization: `Bearer ${signJwt(credentials.applicationId, credentials.privateKey)}`,
          Accept: 'application/json',
        },
      ),
    );
    if (!Array.isArray(list.aspsps)) throw new ConsentError();
    const entry = list.aspsps.find(
      (a: unknown) =>
        !!a &&
        typeof a === 'object' &&
        (a as Record<string, unknown>).name === bank &&
        (a as Record<string, unknown>).country === country,
    ) as Record<string, unknown> | undefined;
    const seconds = entry?.maximum_consent_validity;
    if (
      typeof seconds !== 'number' ||
      !Number.isSafeInteger(seconds) ||
      seconds < DAY_MS / 1000
    )
      throw new ConsentError();
    return Math.min(seconds * 1000, MAX_APPROVAL_DAYS * DAY_MS);
  }
  /**
   * Start an approval. `days` is how long the owner asks for; left out, it is
   * the bank's maximum. More than the bank allows is refused rather than
   * quietly shortened, so the owner never approves a length they did not see.
   */
  async start(
    owner: Owner,
    bank: Bank,
    country: string,
    days?: number,
  ): Promise<string> {
    ownerCheck(owner);
    if (
      !isBankName(bank) ||
      !/^[A-Z]{2}$/.test(country) ||
      (days !== undefined && (!Number.isSafeInteger(days) || days < 1))
    )
      throw new ConsentError();
    const credentials = this.credentials(owner);
    const maximum = await this.maximumApproval(credentials, bank, country);
    if (days !== undefined && days * DAY_MS > maximum) throw new ConsentError();
    const state = randomBytes(32).toString('base64url');
    const digest = hash(state);
    // A minute inside the bank's limit, so the provider's clock — which reads
    // "now" after ours — never sees the request as past it. The bank may
    // shorten the approval further.
    const expiry = new Date(
      Date.now() +
        Math.min(days === undefined ? maximum : days * DAY_MS, maximum - 60000),
    ).toISOString();
    try {
      // An approval that is live stays live: the owner starting another
      // attempt for the same bank — by mistake, or to renew — must not turn
      // it into "pending" before anything has been approved, or its expiry
      // reminders stop and the page shows a fiction. Only the attempt itself
      // (state, country, requested bound) is recorded until the callback.
      const inserted = await this.config.db.query(
        `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,requested_expires_at,status)
        VALUES($1,$2,$3,$4,now()+interval '15 minutes',$5,$5,'pending')
        ON CONFLICT(owner,bank) DO UPDATE SET country=$3,state_hash=$4,state_expires_at=now()+interval '15 minutes',
          requested_expires_at=$5,
          expires_at=CASE WHEN bank_consents.status='authorized' THEN bank_consents.expires_at ELSE $5 END,
          status=CASE WHEN bank_consents.status='authorized' THEN 'authorized' ELSE 'pending' END
        WHERE bank_consents.status != 'processing' RETURNING owner`,
        [owner, bank, country, digest, expiry],
      );
      if (!inserted.rows.length) throw new ConsentError();
      const result = await this.post(credentials, '/auth', {
        access: { valid_until: expiry },
        aspsp: { name: bank, country },
        state,
        redirect_url: this.config.redirectUrl,
        psu_type: 'personal',
      });
      if (typeof result.url !== 'string' || result.url.length > 8192)
        throw new ConsentError();
      const url = new URL(result.url);
      if (
        ![
          'https://auth.enablebanking.com',
          'https://tilisy.enablebanking.com',
        ].includes(url.origin) ||
        url.username ||
        url.password ||
        url.pathname !== '/ais/start' ||
        url.hash
      )
        throw new ConsentError();
      return url.href;
    } catch {
      await this.fail(owner, digest);
      throw new ConsentError();
    }
  }
  /**
   * Mark an attempt failed. A row that was authorised before the attempt goes
   * back to being authorised, with the expiry it had; only an attempt that
   * had nothing to fall back on reads "failed".
   */
  private async fail(
    owner: Owner,
    digest: string,
    before?: { status: string; expiresAt: string },
  ): Promise<void> {
    try {
      if (before?.status === 'authorized')
        await this.config.db.query(
          "UPDATE bank_consents SET status='authorized',expires_at=$3 WHERE owner=$1 AND state_hash=$2",
          [owner, digest, before.expiresAt],
        );
      else
        await this.config.db.query(
          "UPDATE bank_consents SET status='failed' WHERE owner=$1 AND state_hash=$2 AND status<>'authorized'",
          [owner, digest],
        );
    } catch {
      throw new ConsentError();
    }
  }
  async finish(owner: Owner, state: string, code: string): Promise<void> {
    ownerCheck(owner);
    if (
      typeof state !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      typeof code !== 'string' ||
      !code ||
      code.length > 8192 ||
      /[\r\n\0]/.test(code)
    )
      throw new ConsentError();
    const digest = hash(state);
    let claimed = false;
    let before: { status: string; expiresAt: string } | undefined;
    let temporary: string | undefined;
    let installed: string | undefined;
    try {
      // Atomic claim commits before any network operation. Never retry a claimed code.
      // The row's state before the claim is kept so a failed renewal can put
      // a live approval back exactly as it was.
      const result = await this.config.db.query(
        `UPDATE bank_consents SET status='processing'
        FROM (SELECT owner AS o, bank AS b, status AS previous_status, expires_at AS previous_expires_at
              FROM bank_consents WHERE owner=$1 AND state_hash=$2 FOR UPDATE) AS was
        WHERE bank_consents.owner=was.o AND bank_consents.bank=was.b
          AND was.previous_status IN ('pending','authorized') AND bank_consents.state_expires_at>now()
        RETURNING bank_consents.owner,bank_consents.bank,bank_consents.country,
          COALESCE(bank_consents.requested_expires_at,bank_consents.expires_at) AS expires_at,
          was.previous_status,was.previous_expires_at`,
        [owner, digest],
      );
      const row = result.rows[0];
      if (!row) throw new ConsentError();
      claimed = true;
      before = {
        status: String(row.previous_status),
        expiresAt: new Date(
          row.previous_expires_at as string | Date,
        ).toISOString(),
      };
      const credentials = this.credentials(row.owner as Owner);
      const session = await this.post(credentials, '/sessions', { code });
      const aspsp = object(session.aspsp);
      const access = object(session.access);
      if (
        aspsp.name !== row.bank ||
        aspsp.country !== row.country ||
        session.psu_type !== 'personal' ||
        typeof session.session_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          session.session_id,
        ) ||
        typeof access.valid_until !== 'string' ||
        !Number.isFinite(Date.parse(access.valid_until)) ||
        Date.parse(access.valid_until) <= Date.now() ||
        Date.parse(access.valid_until) >
          new Date(row.expires_at as string).getTime()
      )
        throw new ConsentError();
      const directory = await lstat(this.config.secretDirectory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o022) !== 0 ||
        (process.getuid !== undefined && directory.uid !== process.getuid())
      )
        throw new ConsentError();
      const destination = join(
        this.config.secretDirectory,
        `enablebanking-${owner}-${bankSlug(row.bank as BankName)}-session`,
      );
      temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(session.session_id + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      temporary = undefined;
      installed = destination;
      await this.config.db.query(
        "UPDATE bank_consents SET status='authorized',expires_at=$3 WHERE owner=$1 AND state_hash=$2 AND status='processing'",
        [owner, digest, access.valid_until],
      );
    } catch {
      try {
        if (temporary) await unlink(temporary);
        if (installed) await unlink(installed);
      } catch {
        // Cleanup errors must not leak paths or mask the permanently consumed state.
        throw new ConsentError();
      } finally {
        if (claimed) await this.fail(owner, digest, before);
      }
      throw new ConsentError();
    }
  }
  async list(
    owner: Owner,
  ): Promise<
    Array<{ bank: Bank; country: string; expiry: string; status: string }>
  > {
    ownerCheck(owner);
    const result = await this.config.db.query(
      `SELECT bank,country,expires_at,
      CASE WHEN status='pending' AND state_expires_at<=now() THEN 'expired'
      WHEN status='authorized' AND expires_at<=now() THEN 'expired' ELSE status END AS status
      FROM bank_consents WHERE owner=$1 ORDER BY bank`,
      [owner],
    );
    return result.rows.map((row) => ({
      bank: row.bank as Bank,
      country: String(row.country),
      expiry: new Date(row.expires_at as string).toISOString(),
      status: String(row.status),
    }));
  }
}
