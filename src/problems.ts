/**
 * What is broken and waiting for the owner.
 *
 * Everything the household's money depends on runs unattended: five bank
 * connections on timers, an exchange-rate feed, an exchange and a broker read
 * once a month, a classifier with a monthly budget, and a Telegram bot that
 * carries the questions. When one of them stops, the screens do not go wrong —
 * they go quietly incomplete, which is worse, because a total that is missing a
 * bank looks exactly like a total that is simply smaller. Twice in one week a
 * connection stayed silent for most of a day and was noticed only because
 * somebody happened to look at a figure and think it low.
 *
 * So this is the one place that says so. It reads the tables the application
 * already writes and reports nothing of its own: a bank's own sync record, the
 * approvals a provider granted, the exchange rates that were retrieved, the
 * outbox the bot sends from, the classifier's budget. Nothing here is a new
 * store to keep in step with the truth; it is a reading of the truth.
 *
 * Two rules decide what belongs. A problem is something **broken**, not
 * something incomplete: amounts nobody has classified yet are work, not a
 * fault, and they live on the Review screen. And a problem is something **only
 * the owner can fix** — a credential, an approval, a connection that has
 * stopped — which is why every entry carries the page where the fix is rather
 * than the page where the symptom shows.
 *
 * The thresholds are the owner's, set on September 18, 2026: a few hours of
 * missing bank data is no cause for concern, so nothing is reported until a
 * connection has been silent for twenty-five hours, and a bank approval is
 * announced one day before it lapses rather than five.
 */
import type { Executor } from './database.js';
import type { CredentialHealth } from './credential-health.js';
import { bankLabel, bankSlug, isBankName, isBankSlug } from './connectors/banks.js';

/**
 * `critical` is money data that has stopped arriving or will within the day;
 * `warning` is something degraded that has not stopped anything yet. There is
 * no third level: a list that ranks five shades of bad is a list nobody reads.
 */
export type ProblemSeverity = 'critical' | 'warning';

export type Problem = {
  /** Stable across polls, so a row does not remount while it is being read. */
  id: string;
  severity: ProblemSeverity;
  /** What has stopped, named the way the owner names it. */
  title: string;
  /** What to do about it, in one sentence. Never a stack trace or a code. */
  detail: string;
  /** Where the fix is, not where the symptom shows. */
  href: string | null;
  /** When it started, when that is known. */
  since: string | null;
};

/** Twenty-five hours: every instance polls at least six-hourly, so a day of
 * silence is a stopped connection rather than a slow one. */
const SILENT_MS = 25 * 3600000;

/**
 * Three days of no new exchange rate. The rate source publishes on working
 * days, so a Friday-to-Monday gap is ordinary and a shorter threshold would
 * cry wolf every weekend and over every public holiday.
 */
const RATES_STALE_MS = 72 * 3600000;

/**
 * Two hours in the outbox. The sender wakes far more often than that, so a
 * message still queued has not been delayed — nothing is sending it.
 */
const UNDELIVERED_MS = 2 * 3600000;

export type ProblemInputs = {
  now?: Date;
  /** From `credentialHealthFromEnv`; absent outside the server. */
  credentials?: CredentialHealth[];
  /** The newest local database snapshot, if the directory can be read. */
  lastBackupAt?: string | null;
};

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const at = new Date(value as string | Date);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/** `monobank:katya` and `enablebanking:rodion:wise` as the owner reads them. */
export function connectionLabel(connection: string): string {
  const [provider = '', owner = '', bank] = connection.split(':');
  const holder = owner.charAt(0).toUpperCase() + owner.slice(1);
  if (provider === 'monobank') return `Monobank · ${holder}`;
  // Never the integration provider's name: the owner banks with Wise, and has
  // no account at the aggregator that reaches it.
  const name = isBankSlug(bank) ? bankLabel(bank) : bank;
  return name ? `${name} · ${holder}` : holder;
}

function hours(from: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(from)) / 3600000);
}

/**
 * One row per connection, whatever is wrong with it.
 *
 * An expired approval, a rejected credential and a run left latched for review
 * are three ways of writing the same sentence — this bank has stopped and only
 * you can restart it — so they are reported as one entry per bank, taking the
 * most specific reason that applies. Listing them separately would put the same
 * bank on the screen three times and make the list look like three problems.
 */
async function bankProblems(db: Executor, now: Date): Promise<Problem[]> {
  const runs = await db.query(
    'SELECT connection,state,last_success_at,error_code FROM bank_sync_runs ORDER BY connection',
  );
  const consents = await db.query(
    "SELECT owner,bank,expires_at FROM bank_consents WHERE status='authorized'",
  );
  // A consent names the bank the way the provider publishes it ("LHV Pank");
  // the sync record keys the same pair by our own slug, as
  // `enablebanking:<owner>:<slug>`. The registry converts between the two —
  // lowercasing the name would not, which is the whole reason it exists.
  const expiry = new Map<string, string>();
  for (const row of consents.rows) {
    const at = iso(row.expires_at);
    const name = String(row.bank);
    if (at && isBankName(name))
      expiry.set(`${String(row.owner)}:${bankSlug(name)}`, at);
  }
  const problems: Problem[] = [];
  for (const row of runs.rows) {
    const connection = String(row.connection);
    const [, owner = '', slug] = connection.split(':');
    const label = connectionLabel(connection);
    const lastSuccess = iso(row.last_success_at);
    const consentAt = slug ? expiry.get(`${owner}:${slug}`) : undefined;
    const base = { id: `bank:${connection}`, href: '/connections' };
    // Most specific first: an approval that has lapsed explains everything
    // else, and a credential the bank rejected explains a stalled run.
    if (consentAt && Date.parse(consentAt) <= now.getTime())
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} has stopped: the bank approval expired`,
        detail:
          'Nothing imports from this bank until you approve it again on the Bank connections page.',
        since: consentAt,
      });
    else if (
      consentAt &&
      Date.parse(consentAt) - now.getTime() <= 24 * 3600000
    )
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} approval expires within a day`,
        detail:
          'Approve it again on the Bank connections page or the imports stop.',
        since: consentAt,
      });
    else if (row.error_code === 'auth')
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} needs reconnecting`,
        detail: 'The bank refused the credentials this connection holds.',
        since: lastSuccess,
      });
    else if (
      row.state === 'failed' &&
      row.error_code !== 'transient' &&
      row.error_code !== 'rate_limit' &&
      row.error_code !== 'consent_pending'
    )
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} stopped and is waiting to be looked at`,
        detail:
          'The last import did not finish and will not retry on its own. Payments already imported are safe.',
        since: lastSuccess,
      });
    else if (!lastSuccess)
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} has never imported`,
        detail: 'This connection has not completed a single import yet.',
        since: null,
      });
    else if (now.getTime() - Date.parse(lastSuccess) > SILENT_MS)
      problems.push({
        ...base,
        severity: 'critical',
        title: `${label} has not imported for ${hours(lastSuccess, now)} hours`,
        detail:
          'Payments and balances from this bank are missing from every total until it catches up.',
        since: lastSuccess,
      });
  }
  return problems;
}

/** The exchange rates every converted total is built on. */
async function rateProblems(db: Executor, now: Date): Promise<Problem[]> {
  const latest = await db.query(
    'SELECT max(retrieved_at) AS at FROM daily_fx_rates',
  );
  const at = iso(latest.rows[0]?.at);
  if (at && now.getTime() - Date.parse(at) <= RATES_STALE_MS) return [];
  return [
    {
      id: 'fx:stale',
      severity: 'warning',
      title: at
        ? 'No new exchange rate for three days'
        : 'No exchange rates have been retrieved',
      detail:
        'Amounts in other currencies cannot be converted, so every combined total is understated.',
      href: '/fx',
      since: at,
    },
  ];
}

/** The classifier that files new payments without being asked. */
async function classifierProblems(db: Executor): Promise<Problem[]> {
  const meta = await db.query(
    'SELECT pause_reason FROM llm_budget_metadata WHERE singleton',
  );
  const reason = meta.rows[0]?.pause_reason;
  if (!reason) return [];
  return [
    {
      id: 'llm:paused',
      severity: 'warning',
      title: 'Automatic classification is paused',
      detail:
        'New payments arrive unclassified until it resumes, and none are lost meanwhile.',
      href: '/operations',
      since: null,
    },
  ];
}

/**
 * The channel every other warning travels on.
 *
 * This one is worth more than it looks: when the bot stops delivering, the
 * questions the household answers by phone stop arriving and so does every
 * notice about the problems above, silently. A screen is the only place left
 * that can say it.
 */
async function telegramProblems(db: Executor, now: Date): Promise<Problem[]> {
  const stuck = await db.query(
    `SELECT min(created_at) AS since, count(*)::int AS waiting FROM (
       SELECT created_at FROM telegram_outbox WHERE state IN ('queued','uncertain')
       UNION ALL
       SELECT created_at FROM report_delivery WHERE state IN ('queued','uncertain')
     ) undelivered WHERE created_at < $1`,
    [new Date(now.getTime() - UNDELIVERED_MS).toISOString()],
  );
  const row = stuck.rows[0];
  const waiting = Number(row?.waiting ?? 0);
  if (!waiting) return [];
  return [
    {
      id: 'telegram:undelivered',
      severity: 'critical',
      title: `Telegram is not delivering (${waiting} waiting)`,
      detail:
        'Questions and warnings are not reaching the phone. Nothing is lost; it sends when the bot works again.',
      href: '/operations',
      since: iso(row?.since),
    },
  ];
}

/** Credentials that expire on a date somebody wrote down. */
function credentialProblems(credentials: CredentialHealth[]): Problem[] {
  return credentials
    .filter((c) => c.state === 'expired' || c.warningDays !== null)
    .map((c) => ({
      id: `credential:${c.credential}`,
      severity: (c.state === 'expired' || c.warningDays === 0
        ? 'critical'
        : 'warning') as ProblemSeverity,
      title:
        c.state === 'expired'
          ? `${c.label} has expired`
          : c.warningDays === 0
            ? `${c.label} expires today`
            : `${c.label} expires in ${c.warningDays} days`,
      detail: 'Install a replacement and record its new expiry on the server.',
      href: '/operations',
      since: c.expiresAt ?? c.expiresOn,
    }));
}

/**
 * The feeds behind the holdings: the exchange, the broker and the wallet.
 *
 * The Binance key is the reason this is read from the feed's own outcome rather
 * than from a date. It has no expiry to count down to — what kills it is being
 * revoked, going ninety days unused, or the server's address no longer matching
 * the restriction on it — and all three show up the same way, as the feed
 * failing. The broker's token does have a date, and is watched both ways.
 */
async function feedProblems(db: Executor): Promise<Problem[]> {
  const runs = await db.query(
    "SELECT feed,status,ran_at FROM holding_feed_runs WHERE status='failed' ORDER BY feed",
  );
  const named: Record<string, string> = {
    binance: 'Binance',
    ibkr: 'Interactive Brokers',
    wallet: 'The wallet ledger',
  };
  return runs.rows.map((row) => ({
    id: `feed:${String(row.feed)}`,
    severity: 'warning' as ProblemSeverity,
    title: `${named[String(row.feed)] ?? String(row.feed)} could not be read`,
    detail:
      'Holdings it feeds keep their last known value until it can be read again.',
    href: '/assets',
    since: iso(row.ran_at),
  }));
}

/**
 * The snapshot taken before every import.
 *
 * Each scheduled import declares the backup as a hard requirement, so a backup
 * that fails does not merely stop the snapshots — it stops every bank import at
 * once, and nothing else on any screen would say why.
 */
function backupProblems(lastAt: string | null, now: Date): Problem[] {
  if (lastAt && now.getTime() - Date.parse(lastAt) <= SILENT_MS) return [];
  return [
    {
      id: 'backup:stale',
      severity: 'critical',
      title: lastAt
        ? `No database backup for ${hours(lastAt, now)} hours`
        : 'No database backup has been taken',
      detail:
        'Every scheduled import requires a fresh backup first, so imports stop until this succeeds.',
      href: '/operations',
      since: lastAt,
    },
  ];
}

/** Critical first, then longest-standing first within each level. */
function ranked(problems: Problem[]): Problem[] {
  const weight = (p: Problem) => (p.severity === 'critical' ? 0 : 1);
  return [...problems].sort(
    (a, b) =>
      weight(a) - weight(b) ||
      Date.parse(a.since ?? '9999-01-01') - Date.parse(b.since ?? '9999-01-01'),
  );
}

export async function systemProblems(
  db: Executor,
  inputs: ProblemInputs = {},
): Promise<{ generatedAt: string; problems: Problem[] }> {
  const now = inputs.now ?? new Date();
  const [banks, rates, classifier, telegram, feeds] = await Promise.all([
    bankProblems(db, now),
    rateProblems(db, now),
    classifierProblems(db),
    telegramProblems(db, now),
    feedProblems(db),
  ]);
  return {
    generatedAt: now.toISOString(),
    problems: ranked([
      ...banks,
      ...rates,
      ...classifier,
      ...telegram,
      ...feeds,
      ...credentialProblems(inputs.credentials ?? []),
      // Undefined means nobody told this process where the backups are, which
      // is not the same as there being none; say nothing rather than guess.
      ...(inputs.lastBackupAt === undefined
        ? []
        : backupProblems(inputs.lastBackupAt, now)),
    ]),
  };
}
