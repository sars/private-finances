import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Executor } from './database.js';
import type { Owner } from './domain.js';

const OWNERS: readonly Owner[] = ['rodion', 'katya'];

// Two tables, shaped the way a hosted auth library shapes them: a user row
// that owns an address and a hash, and a session row that points at it.
// Nothing else in the application reads them, so moving to a library later is
// a migration of two tables and one re-login, not a rewrite.
export async function initializeAuth(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE users (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`);
  await tx.query(`CREATE TABLE sessions (
    token_digest text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL)`);
  await tx.query('CREATE INDEX sessions_user ON sessions(user_id)');
  await tx.query('CREATE INDEX sessions_expiry ON sessions(expires_at)');
}

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// The cost parameters travel inside every stored hash, so raising them later
// leaves existing passwords verifiable until each is next written. N=2^15 is
// about 32MB and a tenth of a second an attempt; the passwords behind it are
// 48 random hex characters, so the hash is the cheap half of the defence.
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  stored: string,
  password: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: COST.maxmem },
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// An unknown address and a wrong password must cost the same, or the form
// answers "does this person bank here" to anyone who can time it.
let decoy: Promise<string> | undefined;
const decoyHash = () =>
  (decoy ??= hashPassword(randomBytes(32).toString('hex')));

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEWAL_MS = 24 * 60 * 60 * 1000;

// The cookie carries the token; the database keeps only its digest, so a copy
// of the table does not let anyone resume a session.
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const asDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(String(value));

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export type OwnerCredentials = {
  owner: Owner;
  email: string;
  password: string;
};

/**
 * Put the configured owners in the database, and drop the sessions of anyone
 * whose password changed. The environment stays the source of truth: rotating
 * a password is still "edit the file on the server, restart", exactly as it
 * was under Basic authentication, and it is the only way back in because
 * nothing resets a password by email yet. A change-password screen has to
 * take this over — see docs/authentication.md.
 */
export async function seedOwners(
  db: Executor,
  credentials: readonly OwnerCredentials[],
): Promise<void> {
  const addresses = credentials.map((c) => normalizeEmail(c.email));
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Each owner needs an email address of their own');
  for (const { owner, email, password } of credentials) {
    const address = normalizeEmail(email);
    // The same floor Basic authentication enforced. These are generated
    // secrets, not remembered ones, so length is the only check worth making.
    if (password.length < 20)
      throw new Error(
        `${owner}'s password must contain at least 20 characters`,
      );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      throw new Error(`${owner}'s email address is missing or unusable`);
    const { rows } = await db.query<{ password_hash: string; email: string }>(
      'SELECT password_hash, email FROM users WHERE id=$1',
      [owner],
    );
    const existing = rows[0];
    if (
      existing &&
      existing.email === address &&
      (await verifyPassword(existing.password_hash, password))
    )
      continue;
    await db.query(
      `INSERT INTO users(id, email, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET email=$2, password_hash=$3, updated_at=now()`,
      [owner, address, await hashPassword(password)],
    );
    // The credential that opened them is gone, so the sessions go with it.
    if (existing)
      await db.query('DELETE FROM sessions WHERE user_id=$1', [owner]);
  }
}

export type SignedIn = {
  token: string;
  csrf: string;
  owner: Owner;
  expiresAt: Date;
};

export async function signIn(
  db: Executor,
  email: string,
  password: string,
  now = new Date(),
): Promise<SignedIn | null> {
  const { rows } = await db.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email=$1',
    [normalizeEmail(email)],
  );
  const user = rows[0];
  const correct = await verifyPassword(
    user?.password_hash ?? (await decoyHash()),
    password,
  );
  if (!user || !correct || !OWNERS.includes(user.id as Owner)) return null;
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  await db.query(
    'INSERT INTO sessions(token_digest, user_id, csrf, expires_at) VALUES ($1,$2,$3,$4)',
    [digest(token), user.id, csrf, expiresAt.toISOString()],
  );
  return { token, csrf, owner: user.id as Owner, expiresAt };
}

export type ActiveSession = { owner: Owner; csrf: string; expiresAt: Date };

export async function resolveSession(
  db: Executor,
  token: string,
  now = new Date(),
): Promise<ActiveSession | null> {
  const key = digest(token);
  const { rows } = await db.query<{
    user_id: string;
    csrf: string;
    expires_at: unknown;
  }>('SELECT user_id, csrf, expires_at FROM sessions WHERE token_digest=$1', [
    key,
  ]);
  const row = rows[0];
  if (!row || !OWNERS.includes(row.user_id as Owner)) return null;
  const expiresAt = asDate(row.expires_at);
  if (expiresAt.getTime() <= now.getTime()) {
    await db.query('DELETE FROM sessions WHERE token_digest=$1', [key]);
    return null;
  }
  // The expiry slides, so an app opened daily never asks again while one left
  // alone for a month does. Renewing on every request would be a write per
  // page view, so a day of the window has to be spent before the row is
  // touched.
  const renewed = new Date(now.getTime() + SESSION_MS);
  if (renewed.getTime() - expiresAt.getTime() >= RENEWAL_MS) {
    await db.query('UPDATE sessions SET expires_at=$2 WHERE token_digest=$1', [
      key,
      renewed.toISOString(),
    ]);
    return { owner: row.user_id as Owner, csrf: row.csrf, expiresAt: renewed };
  }
  return { owner: row.user_id as Owner, csrf: row.csrf, expiresAt };
}

export async function signOut(db: Executor, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_digest=$1', [digest(token)]);
}

export async function forgetExpiredSessions(
  db: Executor,
  now = new Date(),
): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at <= $1', [
    now.toISOString(),
  ]);
}
