/**
 * What every bank import has been doing, read from the tables the importer
 * already writes: `bank_sync_runs` (the state of each connection), `bank_import_windows`
 * (each completed window with how many payments it changed), `own_accounts`
 * joined with `transactions` (what each account holds), and `bank_consents`
 * (how long the provider's approval lasts). Nothing here is recorded anew; the
 * page that shows it is a view over the importer's own record, so it cannot
 * disagree with the totals.
 *
 * The scheduler's own state — a latch, a rate-limit cooldown — lives in files
 * on the server that the web process deliberately does not read. What it
 * announces about them reaches `bank_sync_runs.retry_reason`, which is how a
 * latched connection shows as stopped here rather than only through its last
 * complete run growing old.
 */
import type { Executor } from './database.js';
import {
  bankLabel,
  bankSlug,
  isBankName,
  isBankSlug,
} from './connectors/banks.js';

export type ImportAccount = {
  accountId: string;
  label: string;
  /** The account's currency as the bank states it; `XXX` for several. */
  currency: string | null;
  purpose: string;
  /** Payments held for the account, all time. */
  transactions: number;
  /** The latest booking the account holds, or null when it holds none. */
  latestBookedAt: string | null;
  /** Payments written or rewritten in the last seven days. */
  changed7d: number;
};

export type ImportConnection = {
  /** `provider:owner[:bank]`, the importer's own key. */
  connection: string;
  provider: 'monobank' | 'enablebanking';
  owner: string;
  /** The bank's slug for the badge registry: `monobank`, `wise`, `lhv`… */
  bank: string | null;
  /** The bank as the owner knows it. */
  label: string;
  /** A key this build cannot name a bank for; shown as the key says it. */
  unrecognised: boolean;
  state: string;
  lastSuccessAt: string | null;
  errorCode: string | null;
  lastRunAt: string | null;
  runs24h: number;
  runs7d: number;
  changed7d: number;
  changed30d: number;
  accounts: ImportAccount[];
  /** The provider's approval, for banks that need one. */
  consent: { status: string; country: string; expiresAt: string } | null;
  /**
   * When the scheduler will next ask this bank anything, and why it is
   * waiting. A bank that has been told to slow down waits half a day, and
   * every timer in between exits without a request, so "the last run failed"
   * on its own reads as a fault when it is usually a rest. Null when nothing
   * is holding it back, and on a release whose scheduler has not run yet.
   */
  nextAttemptAt: string | null;
  retryReason: string | null;
};

export type ImportRun = {
  completedAt: string;
  connection: string;
  accountId: string;
  label: string | null;
  from: string;
  to: string;
  changed: number;
};

export type ImportStatus = {
  generatedAt: string;
  connections: ImportConnection[];
  runs: ImportRun[];
};

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value as string | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** `provider:owner[:bank]` split into what the page needs to name it. */
export function describeConnection(connection: string): {
  provider: 'monobank' | 'enablebanking';
  owner: string;
  bank: string | null;
  label: string;
  unrecognised: boolean;
} {
  const [provider = '', owner = '', bank] = connection.split(':');
  if (provider === 'monobank')
    return {
      provider,
      owner,
      bank: 'monobank',
      label: 'Monobank',
      unrecognised: false,
    };
  if (provider === 'enablebanking') {
    if (isBankSlug(bank))
      return {
        provider,
        owner,
        bank,
        label: bankLabel(bank),
        unrecognised: false,
      };
    // A key this build has no bank for. The importer only writes a bank it
    // knows, so this is a release older than the key it is reading — a bank
    // added by a newer release and seen again after a rollback. The key's own
    // slug is what an operator needs to recognise it, and it is still a bank
    // name rather than the aggregator's, which the owner must never be shown.
    return {
      provider,
      owner,
      bank: null,
      label: bank || 'Unknown bank',
      unrecognised: true,
    };
  }
  return {
    provider: 'enablebanking',
    owner,
    bank: null,
    label: connection,
    unrecognised: true,
  };
}

/**
 * What a connection is doing, as a screen should say it.
 *
 * `bank_sync_runs.state` is written by the import itself, so a process that
 * dies mid-run leaves it at `running` forever: on 23 September 2026 a
 * database restart killed an import of Kate's Monobank and the Bank imports
 * page went on saying "Importing now" for a day. A run is only running while
 * its lease is live, and a connection the scheduler has latched for a person
 * is stopped whatever the last import wrote. `interrupted` is a run that died
 * and is already due to be retried.
 */
export function connectionState(
  row: Record<string, unknown>,
  now: Date,
): string {
  const state = String(row.state);
  const lease = iso(row.lease_until);
  if (state === 'running' && lease && Date.parse(lease) > now.getTime())
    return 'running';
  if (row.retry_reason === 'blocked') return 'stopped';
  // A dead run the scheduler has recognised and put on the transient backoff
  // will be retried by itself; one it has not looked at yet may still be
  // waiting for a person.
  if (state === 'running')
    return row.retry_reason === 'transient' ? 'interrupted' : 'stopped';
  return state;
}

export async function importStatus(
  db: Executor,
  now: Date = new Date(),
): Promise<ImportStatus> {
  const at = now.toISOString();
  const runs = await db.query(
    'SELECT connection,state,lease_until,last_success_at,error_code,retry_after,retry_reason FROM bank_sync_runs ORDER BY connection',
  );
  const windows = await db.query(
    `SELECT connection,
       count(*) FILTER (WHERE completed_at > $1::timestamptz - interval '1 day')::int AS runs_24h,
       count(*) FILTER (WHERE completed_at > $1::timestamptz - interval '7 days')::int AS runs_7d,
       coalesce(sum(changed) FILTER (WHERE completed_at > $1::timestamptz - interval '7 days'),0)::int AS changed_7d,
       coalesce(sum(changed) FILTER (WHERE completed_at > $1::timestamptz - interval '30 days'),0)::int AS changed_30d,
       max(completed_at) AS last_run_at
     FROM bank_import_windows GROUP BY connection`,
    [at],
  );
  // An account belongs to the connection that imported it most recently, so an
  // account once reached through a per-owner connection is listed under the
  // per-bank one that reaches it now.
  const accountConnections = await db.query(
    `SELECT DISTINCT ON (account_id) account_id, connection, currency
     FROM bank_import_windows ORDER BY account_id, completed_at DESC`,
  );
  const accounts = await db.query(
    `SELECT a.account_id, a.label, a.purpose,
       count(t.id)::int AS transactions,
       max(t.booked_at) AS latest_booked_at,
       count(t.id) FILTER (WHERE t.updated_at > $1::timestamptz - interval '7 days')::int AS changed_7d
     FROM own_accounts a
     LEFT JOIN transactions t ON t.account_id = a.account_id AND t.source = a.source
     WHERE a.source IN ('monobank','enablebanking')
     GROUP BY a.account_id, a.label, a.purpose ORDER BY a.label`,
    [at],
  );
  const consents = await db.query(
    'SELECT owner,bank,country,status,expires_at FROM bank_consents',
  );
  const recent = await db.query(
    `SELECT w.completed_at, w.connection, w.account_id, a.label, w.from_at, w.to_at, w.changed
     FROM bank_import_windows w
     LEFT JOIN own_accounts a ON a.account_id = w.account_id
     ORDER BY w.completed_at DESC LIMIT 40`,
  );

  const windowByConnection = new Map(
    windows.rows.map((row) => [String(row.connection), row]),
  );
  const connectionByAccount = new Map(
    accountConnections.rows.map((row) => [
      String(row.account_id),
      { connection: String(row.connection), currency: String(row.currency) },
    ]),
  );
  const accountsByConnection = new Map<string, ImportAccount[]>();
  for (const row of accounts.rows) {
    const home = connectionByAccount.get(String(row.account_id));
    if (!home) continue;
    const list = accountsByConnection.get(home.connection) ?? [];
    list.push({
      accountId: String(row.account_id),
      label: String(row.label),
      currency: home.currency || null,
      purpose: String(row.purpose),
      transactions: Number(row.transactions),
      latestBookedAt: iso(row.latest_booked_at),
      changed7d: Number(row.changed_7d),
    });
    accountsByConnection.set(home.connection, list);
  }
  const consentByConnection = new Map<
    string,
    { status: string; country: string; expiresAt: string }
  >();
  for (const row of consents.rows) {
    const name = String(row.bank);
    if (!isBankName(name)) continue;
    consentByConnection.set(
      `enablebanking:${String(row.owner)}:${bankSlug(name)}`,
      {
        status: String(row.status),
        country: String(row.country),
        expiresAt: iso(row.expires_at) ?? '',
      },
    );
  }

  const connections: ImportConnection[] = runs.rows.map((row) => {
    const connection = String(row.connection);
    const described = describeConnection(connection);
    const window = windowByConnection.get(connection);
    return {
      connection,
      ...described,
      state: connectionState(row, now),
      lastSuccessAt: iso(row.last_success_at),
      errorCode: row.error_code ? String(row.error_code) : null,
      lastRunAt: iso(window?.last_run_at),
      runs24h: Number(window?.runs_24h ?? 0),
      runs7d: Number(window?.runs_7d ?? 0),
      changed7d: Number(window?.changed_7d ?? 0),
      changed30d: Number(window?.changed_30d ?? 0),
      accounts: accountsByConnection.get(connection) ?? [],
      consent: consentByConnection.get(connection) ?? null,
      nextAttemptAt: iso(row.retry_after),
      retryReason: row.retry_reason ? String(row.retry_reason) : null,
    };
  });
  // A bank approved but never imported has no run row yet; it is still a
  // connection the owner is waiting on, so it is listed with what is known.
  for (const [connection, consent] of consentByConnection)
    if (!connections.some((c) => c.connection === connection))
      connections.push({
        connection,
        ...describeConnection(connection),
        state: 'never_run',
        lastSuccessAt: null,
        errorCode: null,
        lastRunAt: null,
        runs24h: 0,
        runs7d: 0,
        changed7d: 0,
        changed30d: 0,
        accounts: [],
        consent,
        nextAttemptAt: null,
        retryReason: null,
      });
  connections.sort((a, b) =>
    a.owner === b.owner
      ? a.label.localeCompare(b.label)
      : a.owner.localeCompare(b.owner),
  );

  return {
    generatedAt: at,
    connections,
    runs: recent.rows.map((row) => ({
      completedAt: iso(row.completed_at) ?? '',
      connection: String(row.connection),
      accountId: String(row.account_id),
      label:
        row.label === null || row.label === undefined
          ? null
          : String(row.label),
      from: iso(row.from_at) ?? '',
      to: iso(row.to_at) ?? '',
      changed: Number(row.changed),
    })),
  };
}
