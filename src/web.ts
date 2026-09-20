import { PaymentExplanations } from './payment-explanations.js';
import { CashTransactions } from './cash-transactions.js';
import {
  readAppSettings,
  updateAppSettings,
  reviewPreferences,
  hiddenByReviewPreferences,
} from './app-settings.js';
import { Receipts } from './receipts.js';
import { historicalReporting } from './historical-reporting.js';
import { reviewWindow, withinReviewWindow } from './review-window.js';
import { needsSpendingReview } from './spending-review.js';
import { transactionDetails } from './transaction-details.js';
import { Refunds } from './refunds.js';
import { SpendingPatterns } from './spending-pattern.js';
import { TransactionTriage } from './transaction-triage.js';
import { llmBudgetSummary } from './llm-budget.js';
import { systemProblems } from './problems.js';
import type {
  BankConsentNotice,
  CredentialHealth,
} from './credential-health.js';
import { backupSummary, type BackupHealth } from './backup-health.js';
import { storageDetail } from './storage-health.js';
import { readStorage } from './storage.js';
import { convertedSpending } from './analytics.js';
import { fxConversionStatus } from './fx-status.js';
import { AccountBalances, convertedBalances } from './account-balances.js';
import { UiLayouts, arrange } from './ui-layout.js';
import {
  aggregateSpending,
  parseAnalyticsOptions,
} from './analytics-aggregation.js';
import { currencyExponent } from './fx.js';
import {
  Categories,
  categoryPath,
  RULE_MATCH_FIELDS,
  type CategoryNode,
  type RuleMatcher,
} from './categories.js';
import type { Kind } from './domain.js';
import type { TelegramClarifications } from './telegram.js';
import type { Classifier } from './classifier.js';
import { Reports, previousReportPeriod } from './reports.js';
import { Accounts } from './accounts.js';
import { Holdings } from './holdings.js';
import {
  fillFromBalances,
  rigaDate,
  runFeeds,
  type FeedCredentials,
  type FeedOutcome,
} from './holding-fill.js';
import type { Fetcher } from './holding-feeds.js';
import { accountDisplayName, ownerNames } from './account-names.js';
import { seedShowcase } from './showcase.js';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseFilters, filterTransactions } from './filters.js';
import { pageTransactions, parsePageQuery } from './transaction-page.js';
import { Repository, Conflict } from './repository.js';
import {
  normalizeEmail,
  resolveSession,
  signIn,
  signOut,
  SESSION_DAYS,
  type ActiveSession,
} from './auth.js';
import { importStatus } from './import-status.js';
import {
  importRun,
  importRuns,
  MAX_RUN_PAGE,
  type RunQuery,
} from './import-runs.js';
import { expenseSummary, type Owner } from './domain.js';
import {
  BANKS,
  bankCountry,
  isBankName,
  type BankName,
} from './connectors/banks.js';

const UUID_ROUTE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The import-runs list's filters, validated at the boundary.
 *
 * Every value that reaches SQL is either a bound parameter or checked here:
 * the connection against the shape the importer writes, the outcome against
 * the three the column allows, the dates against being dates at all. An
 * unreadable value is dropped rather than refused — a filter is a narrowing,
 * and a list that answers nothing because one query parameter was mistyped is
 * worse than one that answers more broadly.
 */
const RUN_OUTCOMES = new Set(['succeeded', 'failed', 'running']);
const RUN_CONNECTION =
  /^(monobank|enablebanking):(rodion|katya)(:[a-z0-9-]{1,40})?$/;
export function parseRunQuery(params: URLSearchParams): RunQuery {
  const query: RunQuery = {};
  const connection = params.get('connection');
  if (connection && RUN_CONNECTION.test(connection))
    query.connection = connection;
  const outcome = params.get('outcome');
  if (outcome && RUN_OUTCOMES.has(outcome))
    query.outcome = outcome as RunQuery['outcome'];
  for (const bound of ['from', 'to'] as const) {
    const value = params.get(bound);
    if (value && Number.isFinite(Date.parse(value)))
      query[bound] = new Date(value).toISOString();
  }
  const cursor = params.get('cursor');
  if (cursor && cursor.length <= 80) query.cursor = cursor;
  const limit = Number(params.get('limit'));
  if (Number.isSafeInteger(limit) && limit > 0)
    query.limit = Math.min(limit, MAX_RUN_PAGE);
  return query;
}

export type WebConfig = {
  frontendDirectory?: string;
  credentialHealth?: () => CredentialHealth[];
  /**
   * When the newest local database snapshot was taken, or null when the
   * directory holds none. Absent means this process was never told where the
   * backups live, which the problems list treats as "say nothing" rather than
   * as "there are none".
   */
  lastBackupAt?: () => Promise<string | null>;
  /** The feeds a snapshot made from the screen may read; absent means only the stored bank balances. */
  holdingFeeds?: {
    credentials: () => Promise<FeedCredentials>;
    fetcher: Fetcher;
    ethRpcUrl?: string;
  };
  port: number;
  mode: 'demo' | 'postgres';
  // Credentials live in the `users` table, seeded from the environment by
  // `seedOwners` before the server listens — see src/auth.ts.
  release: string;
  publicOrigin?: string;
  monobankJarsExcluded?: boolean;
  telegram?: TelegramClarifications;
  classifierFor?: (owner: Owner) => Promise<Classifier>;
  consent?: {
    start(owner: Owner, bank: BankName, country: string): Promise<string>;
    finish(owner: Owner, state: string, code: string): Promise<void>;
    list(
      owner: Owner,
    ): Promise<
      Array<{ bank: string; country: string; expiry: string; status: string }>
    >;
  };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "Wise, Revolut, Swedbank and LHV" — the heading of the provider section. */
/**
 * One approval, said the way the owner reads it: whose it is, which bank, and
 * how long is left. "expired" and "expires today" end the sentence early,
 * because both mean nothing is importing from that bank right now.
 */
function consentSummary(notice: BankConsentNotice): {
  label: string;
  state: string;
} {
  const holder = notice.owner.charAt(0).toUpperCase() + notice.owner.slice(1);
  return {
    label: `${notice.bank} (${notice.country}) \u00b7 ${holder}`,
    state: notice.expired
      ? 'expired'
      : notice.daysRemaining === 0
        ? 'expires today'
        : `${notice.daysRemaining} day(s) left`,
  };
}

function bankListSentence(): string {
  const labels = BANKS.map((b) => b.label);
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const escape = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
// Move routes here only once their React screen is ready.
const frontendRoutes = new Set([
  '/',
  '/accounts',
  '/balances',
  '/reports',
  '/analytics',
  '/receipts',
  '/connections',
  '/imports',
  '/imports/runs',
  '/review',
  '/transactions',
  '/categories',
  '/ops',
  '/fx',
  '/settings',
  '/cash',
  '/assets',
  '/assets/snapshots',
  '/assets/new',
]);
const assetTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // The installable app's manifest; the service worker itself is plain .js.
  '.webmanifest': 'application/manifest+json',
};
async function frontendFile(
  directory: string,
  path: string,
): Promise<Buffer | null> {
  // Reject traversal before filesystem resolution, then reject symlink escapes.
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.')
  )
    return null;
  try {
    const root = await realpath(directory);
    const file = await realpath(resolve(root, path));
    const inside = relative(root, file);
    if (!inside || inside.startsWith('..' + sep) || isAbsolute(inside))
      return null;
    const info = await stat(file);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) return null;
    return await readFile(file);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'EACCES'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return null;
    throw error;
  }
}
function accountForm(
  csrf: string,
  source = '',
  accountId = '',
  label = '',
  purpose = 'personal',
  revision = 0,
) {
  return `<form method="post" action="/accounts"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="expectedRevision" value="${revision}"><label>Reason<input name="reason" required maxlength="500" value="Account purpose updated"></label><label>Provider<input name="source" required maxlength="64" value="${escape(source)}"></label><label>Account reference<input name="accountId" required maxlength="200" value="${escape(accountId)}"></label><label>Name<input name="label" required maxlength="100" value="${escape(label)}"></label><label>Purpose<select name="purpose">${['personal', 'business', 'investment'].map((p) => `<option ${p === purpose ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label>IBAN (optional; leave blank to retain existing)<input name="iban" maxlength="200" autocomplete="off"></label><button>Save account</button></form>`;
}
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const SESSION_COOKIE = 'pf_session';

export function sessionToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE)
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
  }
  return null;
}

// Lax rather than Strict: the bank approval returns here as a redirect from
// the provider, and a Strict cookie is withheld on that first cross-site
// navigation, which would drop the owner on the sign-in screen mid-consent.
function cookie(token: string, seconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${seconds}`,
  ].join('; ');
}
async function body(req: IncomingMessage): Promise<Record<string, string>> {
  if (
    !req.headers['content-type']?.startsWith(
      'application/x-www-form-urlencoded',
    )
  )
    throw new Error('unsupported_body');
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 8192) throw new Error('body_too_large');
  }
  return Object.fromEntries(new URLSearchParams(text));
}
function money(value: string, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === undefined)
    return `${escape(value)} minor units ${escape(currency)}`;
  const n = BigInt(value),
    abs = n < 0n ? -n : n,
    scale = 10n ** BigInt(exponent);
  return `${n < 0n ? '−' : ''}${(abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${exponent ? '.' + String(abs % scale).padStart(exponent, '0') : ''} ${escape(currency)}`;
}
const style = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111715;color:#e4eae6}body{max-width:1180px;margin:auto;padding:32px 24px}a{color:#a3ddbd}nav,header,.toolbar{display:flex;gap:24px;align-items:center;flex-wrap:wrap}header{justify-content:space-between;border-bottom:1px solid #34413a;padding-bottom:20px}h1{font-size:30px;font-weight:550;margin:32px 0 8px}h2{font-size:19px}p,.muted{color:#a7b8ae}.banner{padding:12px 16px;background:#29382a;border-left:3px solid #acc89b;margin-top:24px}.totals{display:flex;gap:20px;flex-wrap:wrap;margin:28px 0}.total{border:1px solid #34413a;padding:22px;min-width:230px}.number{font-size:28px;font-variant-numeric:tabular-nums;margin:12px 0}.warning{color:#e0bd80}table{width:100%;border-collapse:collapse;text-align:left}caption{text-align:left;font-size:19px;margin:20px 0}th,td{padding:16px 12px;border-bottom:1px solid #34413a;vertical-align:top}th{color:#a7b8ae;font-size:12px;text-transform:uppercase;letter-spacing:.08em}.amount{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}button,select,input{font:inherit;padding:9px 12px;border:1px solid #53645a;border-radius:4px;background:#1b2620;color:#e4eae6}button{background:#c1e2b7;color:#18221a;cursor:pointer}label{display:grid;gap:5px;margin:12px 0}details{max-width:320px}summary{cursor:pointer;color:#a3ddbd}pre{white-space:pre-wrap;overflow-wrap:anywhere}.scroll{overflow-x:auto}:focus-visible{outline:3px solid #e0bd80;outline-offset:3px}@media(max-width:650px){body{padding:20px 12px}.total{min-width:0;flex:1}.number{font-size:23px}th,td{padding:12px 8px}}`;
function page(content: string, mode: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private Finances</title><link rel="stylesheet" href="/style.css"></head><body><header><strong>PRIVATE FINANCES</strong><nav aria-label="Main"><a href="/">Transactions</a><a href="/connections">Bank connections</a><a href="/accounts">Own accounts</a><a href="/reports">Reports</a><a href="/fx">Display currency</a><a href="/categories">Categories</a><a href="/review">Review</a><a href="/ops">System health</a></nav></header><div class="banner">${mode === 'demo' ? 'Synthetic data only · Demo' : 'Private family finances · Confirmed spending and pending payments are shown separately'}</div>${content}</body></html>`;
}
export function web(
  repo: Repository,
  config: WebConfig,
  log: (event: Record<string, unknown>) => void = (event) =>
    process.stdout.write(JSON.stringify(event) + '\n'),
) {
  let publicHost: string | undefined;
  if (config.publicOrigin) {
    const origin = new URL(config.publicOrigin);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('publicOrigin must be an HTTPS origin');
    publicHost = origin.host;
  }
  // The feeds run for up to a minute against outside services; two people
  // pressing the button at once must not start two runs.
  let feedsRunning = false;
  // Demo mode signs itself in — there is nobody to authenticate and nothing
  // real behind it — so it needs one token of its own rather than a session
  // row. Every other mode reads the token off the session.
  const demoSession: ActiveSession = {
    owner: 'rodion',
    csrf: randomBytes(32).toString('hex'),
    expiresAt: new Date(8640000000000000),
  };
  // A password guessed at machine speed is the one attack a two-person login
  // actually faces. Failures are counted per address and per caller, both
  // decay, and the delay they buy is the whole defence: there is no lockout
  // to trip deliberately and lock a household member out with.
  const failures = new Map<string, { count: number; until: number }>();
  const penalise = (key: string, now: number) => {
    const seen = failures.get(key);
    const count = (seen && seen.until > now ? seen.count : 0) + 1;
    failures.set(key, {
      count,
      until: now + Math.min(2 ** count * 250, 60_000),
    });
    if (failures.size > 256)
      for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
  };
  const blockedUntil = (keys: string[], now: number) =>
    Math.max(
      0,
      ...keys.map((k) => {
        const seen = failures.get(k);
        return seen && seen.until > now && seen.count > 3 ? seen.until : 0;
      }),
    );
  /**
   * The member whose account a payment sits on, or null when no such payment
   * exists. Either member may read and decide the other's payment in the
   * application, exactly as either may answer for the other in Telegram, so a
   * request that names a payment hands the services the owner stored on the
   * row and keeps the signed-in member as the actor the audit records. Both
   * members are one household; there is no third party to widen this to.
   */
  const paymentOwner = async (id: string | null): Promise<Owner | null> => {
    if (!id || !UUID.test(id)) return null;
    const row = (
      await repo.db.query('SELECT owner FROM transactions WHERE id=$1', [id])
    ).rows[0];
    return row ? (String(row.owner) as Owner) : null;
  };
  return createServer(async (req, res) => {
    const requestId = randomUUID(),
      start = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      config.frontendDirectory
        ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        : "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const html = (content: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(content, config.mode));
    };
    let route = 'unknown';
    try {
      if (
        ![
          `127.0.0.1:${config.port}`,
          `localhost:${config.port}`,
          ...(publicHost ? [publicHost] : []),
        ].includes(req.headers.host ?? '')
      ) {
        json(403, { error: 'invalid_host', requestId });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      route = url.pathname;
      if (req.method === 'GET' && route === '/health/live') {
        json(200, { status: 'alive', release: config.release });
        return;
      }
      // Readiness precedes the session gate: the release script polls it over
      // the loopback interface with no session to present, and its answer is
      // whether the database replies and which release is live, nothing more.
      if (req.method === 'GET' && route === '/health/ready') {
        await repo.db.query('SELECT 1');
        json(200, { status: 'ready', release: config.release });
        return;
      }
      // Besides the hashed bundle under /assets/, the built frontend has a few
      // files at its root: the self-hosted font subsets, the app icon, and the
      // installable app's manifest and service worker. Named explicitly so the
      // root never becomes a general file server.
      const rootFile =
        /^\/(?:fonts\/[A-Za-z0-9_-]+\.woff2|icon(?:-\d+)?\.(?:svg|png)|manifest\.webmanifest|sw\.js|registerSW\.js|workbox-[A-Za-z0-9_-]+\.js)$/.test(
          route,
        );
      const shellRoute =
        req.method === 'GET' &&
        Boolean(config.frontendDirectory) &&
        (frontendRoutes.has(route) ||
          /^\/transactions\/[0-9a-f-]{36}(?:\/history)?$/.test(route) ||
          /^\/imports\/runs\/[0-9a-f-]{36}$/.test(route) ||
          /^\/assets\/[0-9a-f-]{36}$/.test(route) ||
          route.startsWith('/assets/') ||
          rootFile);
      const serveShell = async () => {
        // The bundle lives under /assets/ and so do the holding pages; a build
        // file has an extension the bundler gave it, a page does not.
        const asset =
          (route.startsWith('/assets/') && extname(route) !== '') || rootFile;
        const path = asset ? decodeURIComponent(route.slice(1)) : 'index.html';
        const type = asset
          ? assetTypes[extname(path)]
          : 'text/html; charset=utf-8';
        const content = type
          ? await frontendFile(config.frontendDirectory!, path)
          : null;
        if (!content) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        if (
          asset &&
          /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path)
        )
          res.setHeader(
            'Cache-Control',
            'private, max-age=31536000, immutable',
          );
        // The worker must be re-fetched to learn about a new release; fonts
        // and icons rarely change and may sit in the browser for a day.
        if (path === 'sw.js' || path === 'registerSW.js')
          res.setHeader('Cache-Control', 'no-cache');
        else if (rootFile)
          res.setHeader('Cache-Control', 'private, max-age=86400');
        res.writeHead(200, { 'Content-Type': type! });
        res.end(content);
      };
      const secure = config.mode !== 'demo';
      const token = sessionToken(req);
      const session =
        config.mode === 'demo'
          ? demoSession
          : token
            ? await resolveSession(repo.db, token)
            : null;
      if (req.method === 'POST' && route === '/api/login') {
        if (config.mode === 'demo') {
          json(404, { error: 'not_found', requestId });
          return;
        }
        const form = await body(req);
        const email = (form.email ?? '').slice(0, 320);
        const now = Date.now();
        // Two keys, so guessing one address cannot lock the other member out
        // and moving between addresses does not reset the caller's own count.
        const keys = [
          `email:${normalizeEmail(email)}`,
          `caller:${req.socket.remoteAddress ?? ''}`,
        ];
        const until = blockedUntil(keys, now);
        if (until) {
          log({ event: 'login_throttled', route, requestId });
          res.setHeader('Retry-After', String(Math.ceil((until - now) / 1000)));
          json(429, { error: 'too_many_attempts', requestId });
          return;
        }
        // The address is somebody's identity and the password is a secret:
        // neither belongs in a log line, so only the outcome is recorded.
        const signedIn = await signIn(repo.db, email, form.password ?? '');
        if (!signedIn) {
          for (const key of keys) penalise(key, now);
          log({ event: 'login_failed', route, requestId });
          json(401, { error: 'invalid_credentials', requestId });
          return;
        }
        for (const key of keys) failures.delete(key);
        res.setHeader(
          'Set-Cookie',
          cookie(signedIn.token, SESSION_DAYS * 24 * 60 * 60, secure),
        );
        log({ event: 'login', actor: signedIn.owner, route, requestId });
        json(200, { actor: signedIn.owner, csrf: signedIn.csrf });
        return;
      }
      if (!session) {
        // The shell and its assets are the sign-in screen as much as they are
        // the application, they carry no household data, and this repository
        // publishes the same files — so they load before there is a session.
        if (shellRoute) {
          await serveShell();
          return;
        }
        // An expired or forged token should stop being presented.
        if (token) res.setHeader('Set-Cookie', cookie('', 0, secure));
        json(401, { error: 'unauthorized', requestId });
        return;
      }
      const actor = session.owner;
      const csrf = session.csrf;
      if (req.method === 'POST' && route === '/api/logout') {
        const form = await body(req);
        if (!equals(form.csrf ?? '', csrf)) {
          json(403, { error: 'invalid_csrf', requestId });
          return;
        }
        if (token) await signOut(repo.db, token);
        res.setHeader('Set-Cookie', cookie('', 0, secure));
        log({ event: 'logout', actor, route, requestId });
        json(200, { signedOut: true });
        return;
      }
      if (
        (route === '/settings' || route === '/api/settings') &&
        actor !== 'rodion'
      ) {
        json(403, { error: 'admin_required', requestId });
        return;
      }
      if (req.method === 'GET' && route === '/api/settings') {
        json(200, { settings: await readAppSettings(repo.db) });
        return;
      }
      // Refilling the showcase, on demand and by hand.
      //
      // A page of its own rather than a button in the application, because the
      // demo exists to be photographed and a Reseed button would appear in the
      // article. Demo-only: in every other mode this route does not exist, and
      // the seeder behind it refuses anything but a local PGlite database.
      if (req.method === 'GET' && route === '/showcase/reseed') {
        if (config.mode !== 'demo') {
          json(404, { error: 'not_found', requestId });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>Refill the showcase</title><link rel="stylesheet" href="/style.css"></head>` +
            `<body><h1>Refill the showcase</h1>` +
            `<p>Replaces the invented household with a freshly generated one. ` +
            `The people and their spending come out the same every time; what ` +
            `changes is that the dates end today, so "this month" is current ` +
            `again. Takes a minute.</p>` +
            `<form method="post" action="/showcase/reseed">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
            `<button type="submit">Refill</button></form>` +
            `<p><a href="/">Back to the application</a></p></body></html>`,
        );
        return;
      }
      if (shellRoute) {
        await serveShell();
        return;
      }
      if (req.method === 'GET' && route === '/api/bootstrap') {
        json(200, {
          actor,
          csrf,
          isAdmin: actor === 'rodion',
          reviewDefaults: reviewPreferences(
            await readAppSettings(repo.db),
            new URLSearchParams(),
          ),
          mode: config.mode,
          // The members' on-screen names, so the frontend calls them whatever
          // this process decided. Demo mode renames them for screenshots.
          ownerNames: ownerNames(),
          release: config.release,
          features: {
            ai: Boolean(config.classifierFor),
            telegram: Boolean(config.telegram),
            consent: Boolean(config.consent),
            monobankJarsExcluded: Boolean(config.monobankJarsExcluded),
          },
          // The banks the Connections page may offer: the provider's name is
          // what the form sends back, the label is what the owner reads, and
          // the country is what the form pre-fills when the bank is chosen.
          banks: BANKS.map((b) => ({
            name: b.name,
            label: b.label,
            country: b.country,
          })),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/holdings') {
        // The household's holdings are shared: either member reads and
        // records them, so nothing here is scoped to the actor.
        const report = await new Holdings(repo.db).report(
          url.searchParams.get('display') || 'USD',
          url.searchParams.get('at') || undefined,
        );
        // The accounts a bank holding may be linked to, with the currencies
        // their banks have stated balances in; labels only, no figures.
        const { accounts } = await new AccountBalances(repo.db).household();
        json(200, {
          ...report,
          accounts: accounts.map((account) => ({
            source: account.source,
            accountId: account.accountId,
            owner: account.owner,
            label: account.label,
            currencies: account.balances.map((b) => b.currency),
            // One name for the account wherever it is listed.
            displayName: accountDisplayName({
              owner: account.owner,
              source: account.source,
              label: account.label,
              currency:
                account.balances.length === 1
                  ? account.balances[0]!.currency
                  : null,
            }),
          })),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/accounts') {
        const service = new Accounts(repo.db);
        json(200, {
          accounts: await service.withImpact(actor),
          suggestions: await service.suggestions(actor),
          household: await service.household(),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/balances') {
        // The household, both members, exactly as the overview reports it: the
        // question this screen answers is where the money is, and half an
        // answer to that is not an answer. What each person may *decide* stays
        // owner-scoped elsewhere; this is a view.
        const service = new AccountBalances(repo.db);
        const { accounts } = await service.household();
        const display = url.searchParams.get('display');
        const flat = accounts.flatMap((account) => account.balances);
        // Already in this person's order, so the screen renders what it is
        // given and only the person rearranging has to think about ordering.
        const layout = await new UiLayouts(repo.db).get(actor, 'balances');
        json(200, {
          accounts: arrange(
            accounts.map((account) => ({
              ...account,
              displayName: accountDisplayName({
                owner: account.owner,
                source: account.source,
                label: account.label,
                currency:
                  account.balances.length === 1
                    ? account.balances[0]!.currency
                    : null,
              }),
            })),
            layout.ordering,
            (account) => `${account.source}:${account.accountId}`,
          ),
          layout,
          ...(display
            ? { reporting: await convertedBalances(repo.db, flat, display) }
            : {}),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/categories') {
        const service = new Categories(repo.db);
        json(200, {
          nodes: await service.listNodes(),
          tags: await service.listTags(),
          rules: await service.listRules(actor),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/refund-candidates') {
        const id = url.searchParams.get('id') ?? '';
        const owner = (await paymentOwner(id)) ?? actor;
        const service = new Refunds(repo.db);
        json(200, {
          candidates: await service.candidates(owner, id),
          links: (await service.list(owner)).filter(
            (link) => link.debitId === id || link.creditId === id,
          ),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/transaction-details') {
        const id = url.searchParams.get('id') ?? '';
        const owner = await paymentOwner(id);
        const details = owner
          ? await transactionDetails(repo.db, owner, id)
          : null;
        if (!details) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        json(200, { details });
        return;
      }
      if (req.method === 'GET' && route === '/api/receipt-candidates') {
        json(200, {
          transactions: await new Receipts(repo.db).candidates(
            actor,
            url.searchParams.get('q') ?? '',
          ),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/receipts') {
        json(200, {
          receipts: await new Receipts(repo.db).list(
            actor,
            url.searchParams.get('transactionId'),
          ),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/receipt-image') {
        const image = await new Receipts(repo.db).image(
          actor,
          url.searchParams.get('id') ?? '',
        );
        if (!image) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        res.writeHead(200, {
          'Content-Type': image.mime,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(image.bytes);
        return;
      }
      // The original uploaded file, which for a PDF is what the thumbnail was
      // rendered from. Owner checks are identical to the image route. A PDF is
      // active content in a browser, so it is served sandboxed, never sniffed
      // and never cached.
      if (req.method === 'GET' && route === '/api/receipt-file') {
        const file = await new Receipts(repo.db).file(
          actor,
          url.searchParams.get('id') ?? '',
        );
        if (!file) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        res.writeHead(200, {
          'Content-Type': file.mime,
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        });
        res.end(file.bytes);
        return;
      }
      if (req.method === 'GET' && route === '/api/review') {
        const display = url.searchParams.get('display') ?? 'UAH';
        if (!['UAH', 'EUR', 'USD'].includes(display))
          throw new Error('invalid_display_currency');
        const preferences = reviewPreferences(
          await readAppSettings(repo.db),
          url.searchParams,
        );
        const directId = url.searchParams.get('id');
        const detailOnly = url.searchParams.get('detailOnly') === '1';
        // Either member may read and decide the other's payment, so a request
        // that names one reads it under the payment's own owner: its triage,
        // proposals and replies are listed per owner too. The review queue
        // itself still lists the signed-in member's own payments.
        const subject = detailOnly ? await paymentOwner(directId) : null;
        const scope = subject ?? actor;
        const listed = detailOnly && !subject ? [] : await repo.list(scope);
        // A credit linked to a purchase is already counted through that purchase,
        // so listing it would show the same money twice. The purchase keeps its
        // category and still shows what it finally cost; whether it is listed is
        // now the zero-amount preference's decision, since a purchase refunded in
        // full came to nothing. A link that disagrees with a later correction
        // brings its credit back, because that needs a person (ADR 0007).
        const hiddenRefunds = new Set(
          preferences.hideRefunds
            ? listed
                .filter(
                  (t) =>
                    t.refund?.role === 'refund' &&
                    t.refund.reductions.every(
                      (item) => item.discrepancy === null,
                    ),
                )
                .map((t) => t.id)
            : [],
        );
        const transactions = listed.filter(
          (t) =>
            t.id === directId ||
            (!detailOnly &&
              !hiddenByReviewPreferences(t, preferences) &&
              !hiddenRefunds.has(t.id) &&
              (url.searchParams.get('all') === '1' ||
                needsSpendingReview(t, true, true)) &&
              withinReviewWindow(
                t,
                reviewWindow(url.searchParams.get('window')),
              )),
        );
        const uah = await convertedSpending(repo, transactions, 'UAH');
        const converted =
          display === 'UAH'
            ? uah
            : await convertedSpending(repo, transactions, display);
        const scopeRecords = <T extends Record<string, unknown>>(
          records: T[],
        ) =>
          detailOnly
            ? records.filter((r) =>
                transactions.some((t) => t.id === r.transaction_id),
              )
            : records;
        const service = new Categories(repo.db);
        const { suggestions, tags } = await service.reviewContext(
          scope,
          transactions.map((t) => t.id),
        );
        json(200, {
          transactions,
          reviewPreferences: preferences,
          reporting: {
            currency: display,
            rows: converted.rows.map((r) => ({
              id: r.id,
              convertedAmountMinor: r.convertedAmountMinor,
              // What the payment finally cost. The review screen leads with
              // this and falls back to the account's own currency without it,
              // which showed a refunded purchase in the wrong currency.
              netAmountMinor: r.netAmountMinor,
              method: r.method,
              provenance: r.provenance,
              missingReason: r.missingReason,
            })),
          },
          historicalEstimates: (
            await historicalReporting(repo, transactions, uah)
          ).rows,
          triage: scopeRecords(
            await new TransactionTriage(repo.db, () => undefined).list(scope),
          ),
          suggestions,
          tags,
          proposals: config.classifierFor
            ? scopeRecords(
                await (await config.classifierFor(scope)).list(scope),
              )
            : [],
          replies: scopeRecords(
            [
              ...(config.telegram
                ? (await config.telegram.history(scope)).map((r) => ({
                    ...r,
                    source: 'telegram',
                    created_at: r.created_at,
                  }))
                : []),
              ...(await new PaymentExplanations(repo.db).list(scope)),
            ].sort(
              (a, b) =>
                new Date(String(b.created_at)).getTime() -
                new Date(String(a.created_at)).getTime(),
            ),
          ),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/reports') {
        const scope = url.searchParams.get('owner') || actor;
        if (!['rodion', 'katya', 'all'].includes(scope))
          throw new Error('invalid_owner');
        json(200, {
          reports: await new Reports(repo.db).list(scope as Owner | 'all'),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/connections') {
        json(200, {
          connections: config.consent ? await config.consent.list(actor) : [],
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/history') {
        const id = url.searchParams.get('id') ?? '';
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            id,
          )
        )
          throw new Error('invalid_id');
        const history = await repo.history(id);
        if (!history.length) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        json(200, { history });
        return;
      }
      if (req.method === 'GET' && route === '/api/fx') {
        // Conversion status covers the whole ledger, in every currency a total
        // can be reported in. There is nothing to filter by and no display
        // currency to pick: "is everything counted" is not a question about a
        // subset, and an answer scoped to one currency could read green while
        // another was broken.
        json(
          200,
          await fxConversionStatus(
            repo,
            await repo.list(),
            // A quote is matched to a payment's UTC date, so coverage is
            // counted in UTC days too. Riga's calendar runs two hours ahead,
            // which would leave the strip showing an unfetched day every
            // evening — a warning that is on every night is not a warning.
            new Date().toISOString().slice(0, 10),
          ),
        );
        return;
      }
      if (req.method === 'GET' && route === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(style);
        return;
      }
      if (req.method === 'GET' && route === '/categories') {
        const service = new Categories(repo.db),
          nodes = await service.listNodes(),
          tagList = await service.listTags(),
          rules = await service.listRules(actor);
        html(`<h1>Categories and rules</h1><p>One shared tree for the household, so a family total by category means something. A payment is filed on a leaf; a category with subcategories is a heading, not a choice. Exact-match rules suggest a classification for review; they never silently overwrite your decisions.</p>
        <form method="post" action="/categories"><input type="hidden" name="csrf" value="${csrf}"><label>Name<input name="name" required maxlength="80"></label><label>Parent<select name="parentId"><option value="">None</option>${nodes.map((n) => `<option value="${n.id}">${escape(n.path)}</option>`).join('')}</select></label><button>Add category</button></form>
        ${nodes.map((n) => `<p>${escape(n.path)}${n.assignable ? '' : ' · heading'}</p>`).join('')}
        <h2>Tags</h2><p>Free-form groupings that do not deserve a category. A payment may carry several.</p>
        <form method="post" action="/tags/new"><input type="hidden" name="csrf" value="${csrf}"><label>Name<input name="name" required maxlength="80"></label><button>Add tag</button></form>
        ${tagList.map((t) => `<p>${escape(t.name)}</p>`).join('')}
        <h2>Create an explicit rule</h2><form method="post" action="/rules"><input type="hidden" name="csrf" value="${csrf}"><label>Match<select name="matcherField"><option value="description">the description exactly</option><option value="description_contains">descriptions containing this text</option></select></label><label>Transaction description<input name="description" required maxlength="2000"></label><label>Type<select name="kind">${['personal_expense', 'internal_transfer', 'investment', 'non_personal', 'unresolved'].map((k) => `<option value="${k}">${k.replaceAll('_', ' ')}</option>`).join('')}</select></label><label>Category<select name="categoryId"><option value="">None</option>${nodes
          .filter((n) => n.assignable)
          .map((n) => `<option value="${n.id}">${escape(n.path)}</option>`)
          .join(
            '',
          )}</select></label><label>Reason<input name="reason" required maxlength="500"></label><label><input type="checkbox" name="confirmed" value="yes" required>I confirm this exact-match rule should be suggested in future.</label><button>Create rule</button></form>
        <h2>Current rules</h2>${rules.map((r) => `<section class="total"><p>${r.matcher.field === 'description_contains' ? 'contains ' : ''}${escape(r.matcher.value)} → ${escape(r.kind)} · version ${r.version}</p><form method="post" action="/rules/disable"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="version" value="${r.version}"><button ${!r.active ? 'disabled' : ''}>Disable rule</button></form></section>`).join('')}`);
        return;
      }
      if (req.method === 'GET' && route === '/review') {
        const rows = (await repo.list(actor)).filter(
          (t) =>
            url.searchParams.get('all') === '1' ||
            needsSpendingReview(t, true, true),
        );
        const categories = new Categories(repo.db);
        const nodes = await categories.listNodes();
        const tagOptions = await categories.listTags();
        const proposals = config.classifierFor
          ? await (await config.classifierFor(actor)).list(actor)
          : [];
        const replies = config.telegram
          ? await config.telegram.history(actor)
          : [];
        const cards = [];
        for (const t of rows) {
          const { rules } = await categories.suggest(actor, t.id);
          const tags = await categories.tags(actor, t.id);
          cards.push(
            `<section class="total"><h2>${escape(t.description)}</h2><p>${money(t.amountMinor, t.currency)} · ${escape(t.bookedAt.slice(0, 10))}</p><p>${rules.length} confirmed-rule suggestions. ${rules.length > 1 ? 'Multiple matches need care.' : ''}</p>${rules.map((r) => `<p>${escape(r.kind.replaceAll('_', ' '))} · ${escape(r.categoryId ? categoryPath(nodes, r.categoryId) : '')}</p>`).join('')}<details><summary>Review classification</summary><form method="post" action="/classify"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="revision" value="${t.revision}"><input type="hidden" name="owner" value="${actor}"><label>Type<select name="kind">${['unresolved', 'personal_expense', 'internal_transfer', 'investment', 'non_personal'].map((k) => `<option value="${k}">${k.replaceAll('_', ' ')}</option>`).join('')}</select></label><label>Category<input name="category" list="known-categories" maxlength="80"></label><label>Explanation<input name="reason" required maxlength="500"></label><button>Save decision</button></form></details><form method="post" action="/propose"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="revision" value="${t.revision}"><label>Additional context<input name="clarification" maxlength="2000"></label><button ${config.classifierFor ? '' : 'disabled'}>Request AI suggestion</button></form><p>Tags: ${tags.map((tag) => escape(tag.name)).join(', ') || 'None'}</p><form method="post" action="/tags"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${t.id}"><select name="tagId">${tagOptions
              .map((n) => `<option value="${n.id}">${escape(n.name)}</option>`)
              .join(
                '',
              )}</select><button>Add tag</button></form><form method="post" action="/telegram/queue"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="revision" value="${t.revision}"><button ${config.telegram ? '' : 'disabled'}>Ask about this in Telegram</button></form></section>`,
          );
        }
        html(
          `<h1>Review transactions</h1><p><a href="/review">Spending to review</a> · <a href="/review?all=1">All your transactions</a></p><datalist id="known-categories">${nodes
            .filter((n) => n.assignable)
            .map((n) => `<option value="${escape(n.path)}"></option>`)
            .join(
              '',
            )}</datalist><p>Only your transactions can be changed. Suggestions need your confirmation. ${config.classifierFor ? 'AI suggestions are bounded and never applied automatically.' : 'AI is not configured yet.'}</p>${cards.join('') || '<p>No booked outgoing payments need spending review.</p>'}<h2>Telegram replies</h2>${replies.map((r) => `<section class="total"><p>${escape(r.input_text)}</p><a href="/transactions/${escape(r.transaction_id)}/history">Transaction history</a></section>`).join('') || '<p>No saved replies yet.</p>'}<h2>AI proposal history</h2>${proposals
            .map((p) => {
              const proposal = p.proposal as Record<string, unknown> | null;
              return `<section class="total"><p>${escape(p.state)} · ${escape(proposal?.kind ?? 'No suggestion')} · ${escape(proposal?.category ?? '')}</p><p>${escape(proposal?.explanation ?? '')}</p><a href="/transactions/${escape(p.transaction_id)}/history">Transaction history</a></section>`;
            })
            .join('')}`,
        );
        return;
      }
      if (req.method === 'GET' && route === '/fx') {
        // The no-script twin of the Conversion status screen. It answers the
        // same question in the same order — is everything counted, what is not,
        // and are the rates still arriving — so the two surfaces cannot say
        // different things about the same ledger.
        const status = await fxConversionStatus(
          repo,
          await repo.list(),
          new Date().toISOString().slice(0, 10),
        );
        const missing = status.conversions.missing;
        html(
          `<h1>Conversion status</h1>
          <p class="${missing ? 'warning' : ''}">${missing ? `${missing} of ${status.conversions.total} transactions are missing an amount in at least one reporting currency.` : `All ${status.conversions.total} transactions convert to every reporting currency.`}</p>
          ${status.conversions.currencies.map((entry) => `<section class="total"><h2>${escape(entry.currency)}</h2><p>${entry.method.bank} from the bank · ${entry.method.daily} by daily rate · ${entry.method.identity} already in ${escape(entry.currency)}${entry.missing ? ` · <strong>${entry.missing} missing</strong>` : ''}</p></section>`).join('')}
          ${missing ? `<h2>Not converted</h2>${status.unconverted.map((row) => `<section class="total"><p>${escape(row.bookedAt.slice(0, 10))} · ${escape(row.account.name)} · ${money(row.amountMinor, row.currency)}</p><p>${escape(row.reason)} · no ${escape(row.missingFor.join(', '))} amount</p></section>`).join('')}${status.unconvertedCapped ? `<p>Showing the first ${status.unconverted.length} of ${missing}.</p>` : ''}` : ''}
          <h2>Rates</h2>
          <p>${status.rates.current ? `Rates current through ${escape(status.rates.current)}` : 'No rates are stored'} · ${status.rates.covered} of ${status.rates.needed} days.</p>
          <p>${status.rates.days.filter((day) => day.state === 'not_fetched').length} days not fetched · ${status.rates.days.filter((day) => day.state === 'empty_at_source').length} empty at source.</p>`,
        );
        return;
      }
      if (req.method === 'GET' && route === '/reports') {
        const scope = url.searchParams.get('owner') || actor;
        if (!['rodion', 'katya', 'all'].includes(scope))
          throw new Error('invalid_owner');
        const reports = await new Reports(repo.db).list(scope as Owner | 'all');
        html(`<h1>Weekly and monthly reports</h1><p>Calendar periods use Europe/Riga. Confirmed expenses, unresolved payments and pending payments remain separate. Missing historical FX is never replaced by a current rate.</p>
        <form method="post" action="/reports"><input type="hidden" name="csrf" value="${csrf}"><label>Period<select name="period"><option value="week">Previous week</option><option value="month">Previous month</option></select></label><label>Owner<select name="owner">${['all', 'rodion', 'katya'].map((o) => `<option value="${o}" ${o === scope ? 'selected' : ''}>${o === 'all' ? 'Together' : o}</option>`).join('')}</select></label><button>Create or refresh report</button></form>
        <p><a href="/reports?owner=all">Together</a> · <a href="/reports?owner=rodion">Rodion</a> · <a href="/reports?owner=katya">Katya</a></p>
        ${reports.map((s) => `<section class="total"><h2>${escape(s.report.period.kind)} · ${escape(s.report.owner)} · version ${s.version}</h2><p>${escape(s.report.period.from)} through ${escape(s.report.period.to)} (end exclusive)</p>${s.report.byCurrency.map((t) => `<p>${money(t.personalExpenseMinor, t.currency)} confirmed · ${money(t.unresolvedOutflowMinor, t.currency)} unresolved · ${money(t.pendingOutflowMinor, t.currency)} pending</p>`).join('')}<p class="warning">${s.report.incompleteness.unresolvedCount} unresolved, ${s.report.incompleteness.pendingCount} pending. Import coverage is not yet certified.</p><h3>Categories</h3>${s.report.byCategory.map((c) => `<p>${escape(c.owner)} · ${escape(c.category)}: ${money(c.personalExpenseMinor, c.currency)}</p>`).join('') || '<p>No classified expenses in this period.</p>'}</section>`).join('') || '<p>No reports created for this scope yet.</p>'}`);
        return;
      }
      if (req.method === 'GET' && route === '/accounts') {
        const registry = new Accounts(repo.db);
        const accounts = await registry.list(actor);
        const suggestions = await registry.suggestions(actor);
        html(`<h1>Own accounts</h1><p>Signed in as ${escape(actor)}. Register your other bank or brokerage accounts to help identify transfers. Identifiers are stored as matching hashes. Suggestions always require review.</p>
          ${accounts.map((a) => `<section class="total"><h2>${escape(a.label)}</h2><p>${escape(a.source)} · ${escape(a.purpose)} · ${a.identifierRegistered ? 'Identifier registered' : 'No matching identifier'}</p><details><summary>Edit account purpose and identifier</summary>${accountForm(csrf, a.source, a.accountId, a.label, a.purpose, a.revision)}</details></section>`).join('')}
          <h2>Add another own account</h2>${accountForm(csrf)}
          <h2>Transfers to review</h2>${suggestions.length ? suggestions.map((s) => `<p><a href="/transactions/${escape(s.transactionId)}/history">Review transaction</a> · ${escape(s.proposedKind?.replaceAll('_', ' ') ?? 'Ambiguous match')} · ${escape(s.reason.replaceAll('_', ' '))}</p>`).join('') : '<p>No explicit matching account identifiers found.</p>'}`);
        return;
      }
      if (req.method === 'GET' && route === '/connections') {
        const connections = config.consent
          ? await config.consent.list(actor)
          : [];
        html(
          `<h1>Bank connections</h1><p>Signed in as ${escape(actor)}. Approve only your own bank accounts.</p><h2>Monobank</h2><p>${config.monobankJarsExcluded ? 'Regular accounts only. Jars are excluded from future imports; any previously imported records remain visible.' : 'All API-listed regular accounts and jars are in import scope.'}</p><h2>${escape(bankListSentence())}</h2>${config.consent ? `<p>First link your accounts in Enable Banking's application settings. Then start the separate bank approval below. Keep Tailscale connected when returning here.</p><form method="post" action="/connections/enablebanking/start"><input type="hidden" name="csrf" value="${csrf}"><label>Bank<select name="bank">${BANKS.map((b) => `<option value="${escape(b.name)}">${escape(b.label)}</option>`).join('')}</select></label><label>Country code for the bank connection (blank for the bank's own)<input name="country" pattern="[A-Za-z]{2}" maxlength="2" placeholder="e.g. LV"></label><button>Start bank approval</button></form>` : '<p>Bank approval is not configured yet.</p>'}${connections.map((c) => `<section class="total"><h2>${escape(c.bank)} · ${escape(c.country)}</h2><p>${escape(c.status)} · Valid until ${escape(c.expiry)}</p></section>`).join('')}<p>Approving access does not automatically start transaction imports or classify spending.</p>`,
        );
        return;
      }
      if (
        req.method === 'GET' &&
        route === '/connections/enablebanking/callback'
      ) {
        if (!config.consent) throw new Error('consent_not_configured');
        if (url.searchParams.has('error')) {
          html(
            '<h1>Bank approval was not completed</h1><p>You can try again from <a href="/connections">Bank connections</a>.</p>',
          );
          return;
        }
        await config.consent.finish(
          actor,
          url.searchParams.get('state') ?? '',
          url.searchParams.get('code') ?? '',
        );
        res.writeHead(303, { Location: '/connections' });
        res.end();
        return;
      }
      if (req.method === 'GET' && route === '/api/llm-budget') {
        json(200, await llmBudgetSummary(repo.db));
        return;
      }
      if (req.method === 'GET' && route === '/api/imports') {
        json(200, await importStatus(repo.db));
        return;
      }
      // Every attempt, not only the ones that committed a window. The list is
      // cut with a keyset for the same reason the payments list is, and the
      // filters are the three questions actually asked of it: which bank, how
      // it ended, and when.
      if (req.method === 'GET' && route === '/api/import-runs') {
        json(200, await importRuns(repo.db, parseRunQuery(url.searchParams)));
        return;
      }
      if (req.method === 'GET' && route?.startsWith('/api/import-runs/')) {
        const id = route.slice('/api/import-runs/'.length);
        const run = UUID_ROUTE.test(id) ? await importRun(repo.db, id) : null;
        if (!run) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        json(200, run);
        return;
      }
      if (req.method === 'GET' && route === '/api/problems') {
        json(
          200,
          await systemProblems(repo.db, {
            credentials: config.credentialHealth?.(),
            lastBackupAt: await config.lastBackupAt?.(),
          }),
        );
        return;
      }
      if (req.method === 'GET' && route === '/api/ops') {
        json(200, {
          ...(await repo.health()),
          credentials: config.credentialHealth ? config.credentialHealth() : [],
          storage: await readStorage(),
        });
        return;
      }
      if (req.method === 'GET' && route === '/ops') {
        const health = await repo.health();
        const connections = health.bankConnections as Array<
          Record<string, unknown>
        >;
        const advice: Record<string, string> = {
          auth: 'Reconnect this bank before retrying.',
          consent:
            'Bank consent has expired or was revoked. Reconnect this bank.',
          rate_limit:
            'The bank asked us to slow down. A later scheduled attempt can retry.',
          transient:
            'The bank is temporarily unavailable. A later scheduled attempt can retry.',
          schema:
            'The bank returned unexpected data. Review is needed before importing.',
          incomplete:
            'The bank response was incomplete. No completion is claimed for the failed account window.',
          sync_failed:
            'Import needs review. Previously completed account windows remain saved.',
        };
        const consents = (health.bankConsents ?? []) as BankConsentNotice[];
        const backup = backupSummary(health.backup as BackupHealth | undefined);
        const storage = await readStorage();
        const storageTile = storage
          ? `<section class="total"><span class="muted">Disk</span><div class="number">${Math.round(storage.usedRatio * 100)}%</div><p>${escape(storageDetail(storage))}</p></section>`
          : '';
        html(
          `<h1>System health</h1>${(config.credentialHealth?.() ?? []).map((credential) => `<section class="total"><h2>${escape(credential.label)}</h2><p>${escape(credential.state.replaceAll('_', ' '))} · Expires ${escape(credential.expiresOn ?? credential.expiresAt ?? 'date not configured')}</p><p>Replacement reminders: 5, 2 and 1 calendar days before expiry (Europe/Riga).</p></section>`).join('')}<h2>Bank approvals</h2>${
            consents.length
              ? consents
                  .map((c) => {
                    const summary = consentSummary(c);
                    return `<section class="total"><h2>${escape(summary.label)}</h2><p${c.expired || c.daysRemaining === 0 ? ' class="warning"' : ''}>${escape(summary.state)} \u00b7 Valid until ${escape(c.expiresAt)}</p></section>`;
                  })
                  .join('')
              : '<p>No bank approval is live. Nothing is importing from a bank until one is approved on Bank connections.</p>'
          }<p>Both members' approvals. Each is renewed by the member it belongs to, on Bank connections.</p><div class="totals"><section class="total"><span class="muted">Application database</span><div class="number">Ready</div><p>Connected and responding</p></section><section class="total"><span class="muted">Running release</span><div class="number">${escape(config.release.slice(0, 7))}</div><p>Use this reference when reporting a problem</p></section><section class="total"><span class="muted">Off-server backup</span><div class="number">${escape(backup.headline)}</div><p>${escape(backup.detail)}</p></section>${storageTile}</div><h2>Bank imports</h2>${
            connections.length
              ? connections
                  .map((c) => {
                    const last = c.last_success_at
                      ? new Date(String(c.last_success_at))
                      : null;
                    const fresh =
                      last && Date.now() - last.getTime() <= 86400000;
                    return `<section class="total"><h2>${escape(String(c.connection).replaceAll(':', ' · '))}</h2><p>${escape(c.state)} · ${last ? (fresh ? 'Updated within 24 hours' : 'Last complete run is over 24 hours old') : 'No complete run yet'}</p>${last ? `<p>Last complete run: ${escape(last.toISOString())}</p>` : ''}${c.error_code ? `<p class="warning">${escape(advice[String(c.error_code)] ?? 'Import needs review before retrying.')}</p>` : ''}</section>`;
                  })
                  .join('')
              : '<p>No bank import has run yet. Live imports are being configured.</p>'
          }<p>A complete run covers only its requested date window; it does not prove that all historical transactions are present.</p><details><summary>Technical diagnostics</summary><pre>${escape(JSON.stringify({ ...health, release: config.release }, null, 2))}</pre></details>`,
        );

        return;
      }
      const historyRoute = /^\/transactions\/([0-9a-f-]{36})\/history$/.exec(
        route,
      );
      if (req.method === 'GET' && historyRoute) {
        const events = await repo.history(historyRoute[1]!);
        if (!events.length) {
          json(404, { error: 'not_found', requestId });
          return;
        }
        html(
          `<h1>Transaction history</h1><p>Source corrections and owner decisions are recorded separately.</p><a href="/">Back to transactions</a>${events.map((event) => `<section><h2>${escape(String(event.event).replaceAll('_', ' '))}</h2><p>${escape(event.actor)} · ${escape(new Date(String(event.created_at)).toISOString())}</p><p>${escape(event.reason)}</p><details><summary>Changes</summary><pre>${escape(JSON.stringify({ before: event.before_value, after: event.after_value }, null, 2))}</pre></details></section>`).join('')}`,
        );
        return;
      }
      if (req.method === 'POST') {
        const form = await body(req);
        if (!equals(form.csrf ?? '', csrf)) {
          json(403, { error: 'invalid_csrf', requestId });
          return;
        }
        if (route === '/api/holdings') {
          const holding = await new Holdings(repo.db).upsert(actor, {
            id: form.id,
            name: form.name!,
            kind: form.kind!,
            denomination: form.denomination!,
            invested: form.invested!,
            liquid: form.liquid!,
            owner: form.owner,
            group: form.group,
            maturesOn: form.maturesOn,
            note: form.note,
            archived: form.archived,
            sortOrder: form.sortOrder,
            feed: form.feed,
            feedRef: form.feedRef,
            revision: form.revision,
          });
          json(200, { holding });
          return;
        }
        if (route === '/api/holdings/read-feeds') {
          // A snapshot made from the screen reads the automatic figures at
          // that moment: stored bank balances, the broker, the exchange, the
          // wallets. Only for today — a reading is of now, and writing it
          // under an old date would be a lie. One run at a time.
          if (form.asOf !== rigaDate())
            throw new Error('holdings_feeds_today_only');
          if (feedsRunning) {
            json(409, { error: 'feeds_running', requestId });
            return;
          }
          feedsRunning = true;
          try {
            const outcomes: FeedOutcome[] = await runFeeds(
              repo.db,
              form.asOf,
              config.holdingFeeds
                ? await config.holdingFeeds.credentials()
                : {},
              config.holdingFeeds?.fetcher ??
                ((url, init) =>
                  fetch(url, {
                    ...init,
                    redirect: 'error',
                    signal: AbortSignal.timeout(20000),
                  })),
              { ethRpcUrl: config.holdingFeeds?.ethRpcUrl },
            );
            json(200, { outcomes });
          } finally {
            feedsRunning = false;
          }
          return;
        }
        if (route === '/api/holdings/fill') {
          // The bank part of the monthly job, on demand: stored balances only,
          // no bank is called from here.
          if (!/^\d{4}-\d{2}-\d{2}$/.test(form.asOf ?? ''))
            throw new Error('holdings_invalid_date');
          json(200, { fill: await fillFromBalances(repo.db, form.asOf!) });
          return;
        }
        if (route === '/api/holding-snapshots') {
          const snapshot = await new Holdings(repo.db).recordSnapshot(actor, {
            holdingId: form.holdingId!,
            asOf: form.asOf!,
            amount: form.amount!,
            currency: form.currency || undefined,
            note: form.note,
          });
          json(200, { snapshot });
          return;
        }
        if (route === '/api/holding-snapshots/delete') {
          // A whole mistaken day, every holding and version of it. Shared by
          // both members like the rest of the holdings routes: the snapshots
          // are the household's, not one member's, and a day entered by one is
          // as wrong for the other. Prices are not touched.
          json(200, await new Holdings(repo.db).deleteDay(form.asOf!));
          return;
        }
        if (route === '/api/asset-prices') {
          const price = await new Holdings(repo.db).recordPrice(actor, {
            symbol: form.symbol!,
            asOf: form.asOf!,
            usdPerUnit: form.usdPerUnit!,
          });
          json(200, { price });
          return;
        }
        if (
          route === '/api/payment-explanations' ||
          route === '/api/cash-transactions'
        ) {
          const explanations = new PaymentExplanations(repo.db);
          let id = form.id!;
          let revision = Number(form.revision);
          let text = form.text!;
          // A cash entry is the actor's own; an explanation belongs to whoever
          // the payment belongs to, and the row records who wrote it.
          const owner =
            route === '/api/cash-transactions'
              ? actor
              : ((await paymentOwner(form.id ?? null)) ?? actor);
          if (route === '/api/cash-transactions') {
            const created = await new CashTransactions(repo.db).create(actor, {
              requestId: form.requestId!,
              amount: form.amount!,
              currency: form.currency!,
              date: form.date!,
              description: form.description!,
            });
            id = created.id;
            const transaction = (await repo.list(owner)).find(
              (row) => row.id === id,
            )!;
            revision = transaction.revision;
            text = form.description!;
            const existing = (await explanations.list(owner, id)).find(
              (row) => row.request_id === form.requestId,
            );
            if (existing) {
              json(200, {
                transactionId: id,
                suggestionStatus: existing.workflow_state,
              });
              return;
            }
          }
          let classifier: Classifier | undefined;
          try {
            classifier = await config.classifierFor?.(owner);
          } catch {
            /* Save the owner's explanation even if AI configuration is unavailable. */
          }
          const saved = await explanations.saveAndPropose(
            owner,
            {
              transactionId: id,
              revision,
              text,
              requestId: form.requestId!,
            },
            classifier,
            actor,
          );
          json(
            200,
            route === '/api/cash-transactions'
              ? {
                  transactionId: id,
                  suggestionStatus: saved.workflow_state,
                }
              : {
                  explanation: saved,
                  suggestionStatus: saved.workflow_state,
                  ...(saved.proposal
                    ? {
                        proposal: {
                          id: saved.proposal_id,
                          proposal: saved.proposal,
                        },
                      }
                    : {}),
                },
          );
          return;
        }
        if (route === '/api/settings') {
          const boolean = (key: string) => {
            if (form[key] !== 'true' && form[key] !== 'false')
              throw new Error('invalid_settings');
            return form[key] === 'true';
          };
          if (!/^\d+$/.test(form.revision ?? ''))
            throw new Error('invalid_settings');
          const settings = await updateAppSettings(
            repo.db,
            actor,
            Number(form.revision),
            {
              hideNonPersonal: boolean('hideNonPersonal'),
              hideInternalTransfers: boolean('hideInternalTransfers'),
              hideRefunds: boolean('hideRefunds'),
              hideZeroAmount: boolean('hideZeroAmount'),
            },
          );
          json(200, { settings });
          return;
        }
        if (route === '/api/ui-layout') {
          // A person's own arrangement of a screen, saved under their own name.
          // Unlike the settings screen this is not administrator-gated: it
          // changes nothing about what any figure means, and each member
          // arranges only their own view.
          if (!/^[a-z][a-z-]{0,39}$/.test(form.key ?? ''))
            throw new Error('invalid_layout');
          if (!/^\d+$/.test(form.revision ?? ''))
            throw new Error('invalid_layout');
          let ordering: unknown;
          try {
            ordering = JSON.parse(form.ordering ?? '');
          } catch {
            throw new Error('invalid_layout');
          }
          json(200, {
            layout: await new UiLayouts(repo.db).save(
              actor,
              form.key!,
              ordering,
              Number(form.revision),
            ),
          });
          return;
        }
        if (
          route === '/receipts/attach' ||
          route === '/receipts/rematch' ||
          route === '/receipts/delete'
        ) {
          const service = new Receipts(repo.db);
          if (route === '/receipts/attach') {
            if (!(await service.attach(actor, form.id!, form.transactionId!))) {
              json(404, { error: 'not_found', requestId });
              return;
            }
          } else if (route === '/receipts/delete') {
            const outcome = await service.delete(actor, form.id!);
            if (outcome === 'not_found') {
              json(404, { error: 'not_found', requestId });
              return;
            }
            if (outcome === 'busy') {
              json(409, { error: 'receipt_processing', requestId });
              return;
            }
          } else await service.match(form.id!, actor);
          res.writeHead(303, { Location: '/receipts' });
          res.end();
          return;
        }
        if (route === '/refund/link') {
          await new Refunds(repo.db).link({
            debitId: form.debitId!,
            creditId: form.creditId!,
            expectedDebitRevision: Number(form.debitRevision),
            expectedCreditRevision: Number(form.creditRevision),
            owner: (await paymentOwner(form.debitId ?? null)) ?? actor,
            actor,
            reason: form.reason!,
          });
          res.writeHead(303, { Location: '/review?all=1' });
          res.end();
          return;
        }
        if (route === '/refund/unlink') {
          await new Refunds(repo.db).unlink(
            form.id!,
            Number(form.revision),
            actor,
            form.reason!,
          );
          res.writeHead(303, { Location: '/review?all=1' });
          res.end();
          return;
        }
        if (route === '/spending-pattern') {
          if (
            !['routine', 'exceptional', 'unreviewed'].includes(
              form.pattern ?? '',
            )
          )
            throw new Error('invalid_spending_pattern');
          await new SpendingPatterns(repo.db).set(
            form.id!,
            Number(form.revision),
            (await paymentOwner(form.id ?? null)) ?? actor,
            form.pattern as 'routine' | 'exceptional' | 'unreviewed',
            form.reason!,
            Number(form.annotationRevision),
            actor,
          );
          res.writeHead(303, { Location: '/review?all=1' });
          res.end();
          return;
        }
        if (route === '/telegram/queue') {
          if (!config.telegram) throw new Error('telegram_not_configured');
          // The question is addressed to whoever's card was used, whichever of
          // them sends it; either may answer, and the reply records which did.
          const owner = await paymentOwner(form.id ?? null);
          const row =
            owner && (await repo.list(owner)).find((t) => t.id === form.id);
          if (!row) throw new Error('not_found');
          await config.telegram.queue(
            row.id,
            Number(form.revision),
            `${row.owner}: ${row.description} (${row.amountMinor} minor units ${row.currency}, ${row.bookedAt.slice(0, 10)}). What was this payment for? Reply to this message.`,
            row.owner,
          );
          res.writeHead(303, { Location: '/review' });
          res.end();
          return;
        }
        if (route === '/tags') {
          const service = new Categories(repo.db);
          const owner = (await paymentOwner(form.id ?? null)) ?? actor;
          const current = await service.tags(owner, form.id!);
          // `tagIds` replaces the whole set, which is what a multi-select
          // editor means by saving; `tagId` keeps adding one, as the plain
          // HTML form does.
          await service.setTags(
            owner,
            form.id!,
            form.tagIds === undefined
              ? [...new Set([...current.map((t) => t.id), form.tagId!])]
              : [
                  ...new Set(
                    form.tagIds
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  ),
                ],
          );
          res.writeHead(303, { Location: '/review' });
          res.end();
          return;
        }
        if (route === '/categories') {
          await new Categories(repo.db).saveNode({
            name: form.name!,
            parentId: form.parentId || null,
          });
          res.writeHead(303, { Location: '/categories' });
          res.end();
          return;
        }
        if (route === '/tags/new') {
          await new Categories(repo.db).saveTag(form.name!);
          res.writeHead(303, { Location: '/categories' });
          res.end();
          return;
        }
        if (route === '/rules') {
          const field = (form.matcherField ??
            'description') as RuleMatcher['field'];
          if (!RULE_MATCH_FIELDS.includes(field))
            throw new Error('invalid_rule_matcher');
          await new Categories(repo.db).saveRule(actor, {
            matcher: { field, value: form.matcherValue ?? form.description! },
            kind: form.kind as Kind,
            categoryId: form.categoryId || null,
            confirmed: form.confirmed === 'yes',
            reason: form.reason!,
          });
          res.writeHead(303, { Location: '/categories' });
          res.end();
          return;
        }
        if (route === '/rules/disable') {
          const service = new Categories(repo.db),
            rule = (await service.listRules(actor)).find(
              (r) => r.id === form.id,
            );
          if (!rule) throw new Error('rule_not_found');
          await service.saveRule(actor, {
            ...rule,
            expectedVersion: Number(form.version),
            confirmed: true,
            reason: 'Disabled by owner',
            active: false,
          });
          res.writeHead(303, { Location: '/categories' });
          res.end();
          return;
        }
        if (route === '/propose') {
          if (!config.classifierFor)
            throw new Error('classifier_not_configured');
          await (
            await config.classifierFor(actor)
          ).propose(form.id!, Number(form.revision), actor, form.clarification);
          res.writeHead(303, { Location: '/review' });
          res.end();
          return;
        }
        if (route === '/reports') {
          const scope = form.owner || actor;
          if (
            !['rodion', 'katya', 'all'].includes(scope) ||
            !['week', 'month'].includes(form.period ?? '')
          )
            throw new Error('invalid_report');
          await new Reports(repo.db).save(await repo.list(), {
            owner: scope as Owner | 'all',
            period: previousReportPeriod(
              form.period as 'week' | 'month',
              new Date(),
            ),
          });
          res.writeHead(303, { Location: `/reports?owner=${scope}` });
          res.end();
          return;
        }
        if (route === '/accounts') {
          const existing = (await new Accounts(repo.db).list(actor)).find(
            (a) => a.source === form.source && a.accountId === form.accountId,
          );
          if (existing && !form.expectedRevision)
            throw new Error('account_revision_required');
          if (
            existing &&
            existing.purpose !== form.purpose &&
            !form.reason?.trim()
          )
            throw new Error('account_rule_reason_required');
          await new Accounts(repo.db).upsert(
            {
              source: form.source,
              accountId: form.accountId,
              owner: actor,
              label: form.label,
              purpose: form.purpose,
              ...(form.expectedRevision !== undefined
                ? { expectedRevision: Number(form.expectedRevision) }
                : {}),
              ...(form.reason?.trim() ? { reason: form.reason } : {}),
              ...(form.iban?.trim()
                ? { identifier: { scheme: 'iban', value: form.iban } }
                : {}),
            },
            actor,
          );
          res.writeHead(303, { Location: '/accounts' });
          res.end();
          return;
        }
        if (route === '/connections/enablebanking/start') {
          if (!config.consent) throw new Error('consent_not_configured');
          const bank = form.bank;
          if (!isBankName(bank)) throw new Error('invalid_bank');
          // A blank country means the bank's own; a wrong one still fails at
          // the provider rather than being second-guessed here.
          const country =
            (form.country ?? '').trim().toUpperCase() || bankCountry(bank);
          const target = await config.consent.start(actor, bank, country);
          const destination = new URL(target);
          if (
            destination.protocol !== 'https:' ||
            !['auth.enablebanking.com', 'tilisy.enablebanking.com'].includes(
              destination.hostname,
            ) ||
            destination.username ||
            destination.password ||
            destination.port
          )
            throw new Error('invalid_consent_url');
          if (req.headers.accept?.includes('application/json')) {
            json(200, { redirect: target });
            return;
          }
          html(
            `<h1>Approve ${escape(bank)} access</h1><p>You will continue to Enable Banking and your bank. Review the requested accounts and approve access there.</p><p><a href="${escape(target)}" rel="noreferrer">Continue to bank approval</a></p><a href="/connections">Cancel</a>`,
          );
          return;
        }
        if (route === '/showcase/reseed') {
          if (config.mode !== 'demo') {
            json(404, { error: 'not_found', requestId });
            return;
          }
          const seeded = await seedShowcase(repo.db);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
              `<title>Showcase refilled</title>` +
              `<link rel="stylesheet" href="/style.css"></head>` +
              `<body><h1>Showcase refilled</h1><p>${seeded.transactions} payments, ` +
              `${seeded.holdings} holdings and ${seeded.rates} daily rates.</p>` +
              `<p><a href="/">Back to the application</a></p></body></html>`,
          );
          return;
        }
        if (route === '/import') {
          if (config.mode !== 'demo') {
            json(403, { error: 'demo_only', requestId });
            return;
          }
          await repo.enqueue();
          // A bounded synthetic import, not an HTTP call to a bank. Durable jobs survive restart.
        } else if (route === '/classify') {
          if (!/^[0-9a-f-]{36}$/.test(form.id ?? ''))
            throw new Error('invalid_id');
          // The payment's own row says whose it is, so `form.owner` is not
          // read: an older form posts the actor there and the current one the
          // payment's owner, and both are already known here. Demo mode, where
          // everyone signs in as rodion, is covered by the same lookup.
          const owner = (await paymentOwner(form.id!)) ?? actor;
          if (form.explanationId) {
            await new PaymentExplanations(repo.db).confirm(
              owner,
              {
                explanationId: form.explanationId,
                transactionId: form.id!,
                revision: Number(form.revision),
                kind: form.kind as Kind,
                category: form.category?.trim() || null,
                reason: form.reason!,
              },
              actor,
            );
          } else {
            await repo.classify(
              form.id!,
              Number(form.revision),
              {
                kind: form.kind,
                category: form.category?.trim() || null,
                reason: form.reason,
              },
              actor,
              owner,
            );
          }
          // Opt-in only: one confirmed decision may become a rule for future
          // payments, but a decision never generalises on its own.
          if (form.futureRule === 'yes')
            await new Categories(repo.db).saveRuleFromDescription(owner, {
              transactionId: form.id!,
              kind: form.kind as Kind,
              category: form.category?.trim() || null,
              reason: form.reason!,
            });
        } else {
          json(404, { error: 'not_found', requestId });
          return;
        }
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        json(405, { error: 'method_not_allowed', requestId });
        return;
      }
      if (route === '/api/transactions') {
        // One page, chosen and cut by the database, in the grammar Analytics
        // speaks plus what a list needs; see transaction-page.ts. The rows
        // are enriched only for the page: their tags and rule suggestions,
        // any pending AI triage, the display conversion and the historical
        // estimates that the review screen shows as badges.
        const query = parsePageQuery(url.searchParams);
        const preferences = reviewPreferences(
          await readAppSettings(repo.db),
          url.searchParams,
        );
        const page = await pageTransactions(repo, query, preferences);
        const ids = page.transactions.map((t) => t.id);
        const owners = [...new Set(page.transactions.map((t) => t.owner))];
        const service = new Categories(repo.db);
        const suggestions: Record<string, unknown> = {};
        const tags: Record<string, unknown> = {};
        for (const member of owners) {
          const context = await service.reviewContext(
            member,
            page.transactions
              .filter((t) => t.owner === member)
              .map((t) => t.id),
          );
          Object.assign(suggestions, context.suggestions);
          Object.assign(tags, context.tags);
        }
        const triage = (
          await Promise.all(
            owners.map((member) =>
              new TransactionTriage(repo.db, () => undefined).list(member),
            ),
          )
        )
          .flat()
          .filter((row) => ids.includes(String(row.transaction_id)));
        const receipts = ids.length
          ? Object.fromEntries(
              (
                await repo.db.query(
                  `SELECT transaction_id,count(*) AS total FROM receipt_jobs
                   WHERE state='matched' AND transaction_id=ANY($1::uuid[]) GROUP BY transaction_id`,
                  [ids],
                )
              ).rows.map((row) => [
                String(row.transaction_id),
                Number(row.total),
              ]),
            )
          : {};
        // The amount filter converts the page itself; otherwise convert here.
        // Historical estimates are judged in UAH whatever is displayed.
        const converted =
          query.display && !page.reporting
            ? await convertedSpending(repo, page.transactions, query.display)
            : undefined;
        const reporting = page.reporting ?? converted;
        const uah =
          converted && query.display === 'UAH'
            ? converted
            : reporting
              ? await convertedSpending(repo, page.transactions, 'UAH')
              : undefined;
        json(200, {
          transactions: page.transactions,
          total: page.total,
          nextCursor: page.nextCursor,
          reviewPreferences: preferences,
          ...(reporting
            ? {
                reporting: {
                  currency: reporting.currency,
                  rows: reporting.rows.map((r) => ({
                    id: r.id,
                    convertedAmountMinor: r.convertedAmountMinor,
                    netAmountMinor: r.netAmountMinor,
                    method: r.method,
                    provenance: r.provenance,
                    missingReason: r.missingReason,
                  })),
                },
                historicalEstimates: (
                  await historicalReporting(repo, page.transactions, uah!)
                ).rows,
              }
            : {}),
          triage,
          suggestions,
          tags,
          receipts,
        });
        return;
      }
      const owner = url.searchParams.get('owner') || undefined;
      if (owner && owner !== 'rodion' && owner !== 'katya')
        throw new Error('invalid_owner');
      const filters = parseFilters(url.searchParams);
      // The window goes to the database; everything else is decided here, on a
      // set that is already a period rather than a lifetime. The same filter
      // still runs over the result, so the two can only ever agree: if the
      // clause below were ever wrong, this would still return the right rows.
      const rows = filterTransactions(
        await repo.listWindow(
          owner as Owner | undefined,
          filters.from,
          filters.to,
        ),
        filters,
      );
      if (route === '/api/analytics') {
        // The same rows and the same conversion as the list above, grouped;
        // a drill link built from this grammar lists what made the figure.
        const display = url.searchParams.get('display');
        if (!display) throw new Error('invalid_display_currency');
        const options = parseAnalyticsOptions(url.searchParams);
        const reporting = await convertedSpending(repo, rows, display);
        json(200, {
          currency: reporting.currency,
          ...aggregateSpending(rows, reporting.rows, options),
        });
        return;
      }
      const summary = expenseSummary(rows);
      if (route === '/api/overview') {
        const reporting = url.searchParams.has('display')
          ? await convertedSpending(
              repo,
              rows,
              url.searchParams.get('display')!,
            )
          : undefined;
        json(200, {
          transactions: rows,
          ...summary,
          ...(reporting
            ? {
                reporting: {
                  ...reporting,
                  historicalEstimates: await historicalReporting(
                    repo,
                    rows,
                    reporting,
                  ),
                },
              }
            : {}),
        });
        return;
      }
      if (route === '/api/summary') {
        json(200, summary);
        return;
      }
      if (route !== '/') {
        json(404, { error: 'not_found', requestId });
        return;
      }
      const cards = summary.byCurrency
        .map(
          (t) =>
            `<section class="total"><span class="muted">Confirmed personal expenses</span><div class="number">${money(t.personalExpenseMinor, t.currency)}</div><span class="warning">${money(t.unresolvedOutflowMinor, t.currency)} awaiting classification (${t.unresolvedCount})</span><br><span class="muted">${money(t.pendingOutflowMinor, t.currency)} pending (${t.pendingCount})</span></section>`,
        )
        .join('');
      const table = rows
        .map(
          (t) =>
            `<tr><td>${escape(t.bookedAt.slice(0, 10))}<br><span class="muted">${escape(t.owner)}</span></td><td>${escape(t.description)}<br><span class="muted">${escape(t.category ?? 'No category')}</span></td><td class="amount">${money(t.amountMinor, t.currency)}</td><td>${t.status === 'pending' ? '<strong>Pending</strong><br>' : ''}${escape(t.kind.replaceAll('_', ' '))}<br><a href="/transactions/${t.id}/history">History</a>${config.mode === 'demo' || t.owner === actor ? `<details><summary>Classify</summary><form method="post" action="/classify"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="revision" value="${t.revision}"><input type="hidden" name="owner" value="${t.owner}"><label>Type<select name="kind">${['unresolved', 'personal_expense', 'internal_transfer', 'investment', 'non_personal'].map((k) => `<option value="${k}" ${k === t.kind ? 'selected' : ''}>${k.replaceAll('_', ' ')}</option>`).join('')}</select></label><label>Category<input name="category" maxlength="80" value="${escape(t.category ?? '')}"></label><label>Reason<input name="reason" required maxlength="500"></label><button>Save classification</button></form></details>` : ''}</td></tr>`,
        )
        .join('');
      html(
        `<h1>Family spending</h1><p>Only confirmed personal outflows count. Use Currency conversion for totals in one display currency with daily commercial estimates. Totals below use the same filters as the transaction list.</p><div class="toolbar"><form method="get"><label>Account owner<select name="owner"><option value="">Together</option><option value="rodion" ${owner === 'rodion' ? 'selected' : ''}>Rodion</option><option value="katya" ${owner === 'katya' ? 'selected' : ''}>Katya</option></select></label><label>From (Europe/Riga)<input type="date" name="from" value="${escape(filters.from ?? '')}"></label><label>Through (Europe/Riga)<input type="date" name="to" value="${escape(filters.to ?? '')}"></label><label>Currency<input name="currency" placeholder="All currencies" maxlength="3" value="${escape(filters.currency ?? '')}"></label><label>Category<input name="category" placeholder="All categories" maxlength="80" value="${escape(filters.category ?? '')}"></label><button>Apply filters</button> <a href="/">Clear filters</a></form>${config.mode === 'demo' ? `<form action="/import" method="post"><input type="hidden" name="csrf" value="${csrf}"><button>Import example transactions</button></form>` : ''}</div><div class="totals">${cards}</div>${rows.length ? `<div class="scroll"><table><caption>${rows.length} transactions</caption><thead><tr><th scope="col">Date / owner</th><th scope="col">Transaction</th><th scope="col">Amount</th><th scope="col">Classification</th></tr></thead><tbody>${table}</tbody></table></div>` : `<h2>No transactions yet</h2><p>${config.mode === 'demo' ? 'Import the examples to try classification. Importing them again will not create duplicates.' : 'Bank imports will appear here after the server connection is configured.'}</p>`}`,
      );
    } catch (error) {
      const status =
        error instanceof Conflict
          ? 409
          : route === '/health/ready' ||
              route === '/api/ops' ||
              route === '/api/imports' ||
              route === '/api/problems' ||
              route === '/api/llm-budget' ||
              route === '/ops'
            ? 503
            : 400;
      json(status, {
        error:
          status === 409
            ? 'stale_revision'
            : status === 503
              ? 'dependency_unavailable'
              : 'request_failed',
        requestId,
      });
    } finally {
      // No paths, query strings, form contents, credentials, or source descriptions in logs.
      log({
        time: new Date().toISOString(),
        event: 'http_request',
        requestId,
        status: res.statusCode,
        durationMs: Date.now() - start,
        release: config.release,
      });
    }
  });
}
