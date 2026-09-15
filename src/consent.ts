import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { migrate, type Database } from './database.js';
import type { Owner } from './domain.js';
import { signJwt } from './connectors/enablebanking.js';

type Bank = 'Wise' | 'Revolut';
export type ConsentCredentials = { applicationId: string; privateKey: string };
/** A single, non-retrying POST. Production transport only permits these AIS endpoints. */
export type ConsentPost = (
  path: '/auth' | '/sessions',
  body: Record<string, unknown>,
  headers: Record<string, string>,
) => Promise<unknown>;
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
};

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
  async start(owner: Owner, bank: Bank, country: string): Promise<string> {
    ownerCheck(owner);
    if (!['Wise', 'Revolut'].includes(bank) || !/^[A-Z]{2}$/.test(country))
      throw new ConsentError();
    const credentials = this.credentials(owner);
    const state = randomBytes(32).toString('base64url');
    const digest = hash(state);
    // A bounded initial consent; provider may shorten this further.
    const expiry = new Date(Date.now() + 10 * 86400000).toISOString();
    try {
      const inserted = await this.config.db.query(
        `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
        VALUES($1,$2,$3,$4,now()+interval '15 minutes',$5,'pending')
        ON CONFLICT(owner,bank) DO UPDATE SET country=$3,state_hash=$4,state_expires_at=now()+interval '15 minutes',expires_at=$5,status='pending'
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
  private async fail(owner: Owner, digest: string): Promise<void> {
    try {
      await this.config.db.query(
        "UPDATE bank_consents SET status='failed' WHERE owner=$1 AND state_hash=$2",
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
    let temporary: string | undefined;
    let installed: string | undefined;
    try {
      // Atomic claim commits before any network operation. Never retry a claimed code.
      const result = await this.config.db.query(
        `UPDATE bank_consents SET status='processing'
        WHERE owner=$1 AND state_hash=$2 AND status='pending' AND state_expires_at>now()
        RETURNING owner,bank,country,expires_at`,
        [owner, digest],
      );
      const row = result.rows[0];
      if (!row) throw new ConsentError();
      claimed = true;
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
        `enablebanking-${owner}-${String(row.bank).toLowerCase()}-session`,
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
        if (claimed) await this.fail(owner, digest);
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
