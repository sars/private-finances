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
import {
  reviewWindow,
  withinReviewWindow,
  reviewPriority,
} from './review-window.js';
import { needsSpendingReview } from './spending-review.js';
import { transactionDetails } from './transaction-details.js';
import { Refunds } from './refunds.js';
import { SpendingPatterns } from './spending-pattern.js';
import { TransactionTriage } from './transaction-triage.js';
import { llmBudgetSummary } from './llm-budget.js';
import type { CredentialHealth } from './credential-health.js';
import { convertedSpending } from './analytics.js';
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
import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseFilters, filterTransactions } from './filters.js';
import { Repository, Conflict } from './repository.js';
import { expenseSummary, type Owner } from './domain.js';

export type WebConfig = {
  frontendDirectory?: string;
  credentialHealth?: () => CredentialHealth;
  port: number;
  mode: 'demo' | 'postgres';
  passwords?: Record<Owner, string>;
  release: string;
  publicOrigin?: string;
  monobankJarsExcluded?: boolean;
  telegram?: TelegramClarifications;
  classifierFor?: (owner: Owner) => Promise<Classifier>;
  consent?: {
    start(
      owner: Owner,
      bank: 'Wise' | 'Revolut',
      country: string,
    ): Promise<string>;
    finish(owner: Owner, state: string, code: string): Promise<void>;
    list(
      owner: Owner,
    ): Promise<
      Array<{ bank: string; country: string; expiry: string; status: string }>
    >;
  };
};
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
  '/reports',
  '/analytics',
  '/receipts',
  '/connections',
  '/review',
  '/categories',
  '/ops',
  '/fx',
  '/settings',
  '/cash',
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
export function authenticate(
  req: IncomingMessage,
  config: WebConfig,
): Owner | null {
  if (config.mode === 'demo') return 'rodion';
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const index = decoded.indexOf(':');
  const owner = decoded.slice(0, index);
  if (owner !== 'rodion' && owner !== 'katya') return null;
  return equals(decoded.slice(index + 1), config.passwords?.[owner] ?? '')
    ? owner
    : null;
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
  if (
    config.mode === 'postgres' &&
    (!config.passwords ||
      Object.values(config.passwords).some((p) => p.length < 20))
  )
    throw new Error('Both owner passwords must contain at least 20 characters');
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
  const csrfByOwner = {
    rodion: randomBytes(32).toString('hex'),
    katya: randomBytes(32).toString('hex'),
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
        ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
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
      const actor = authenticate(req, config);
      if (!actor) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Private Finances"');
        json(401, { error: 'unauthorized', requestId });
        return;
      }
      const csrf = csrfByOwner[actor];
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
      if (
        req.method === 'GET' &&
        config.frontendDirectory &&
        (frontendRoutes.has(route) ||
          /^\/transactions\/[0-9a-f-]{36}\/history$/.test(route) ||
          route.startsWith('/assets/'))
      ) {
        const asset = route.startsWith('/assets/');
        const path = asset ? decodeURIComponent(route.slice(1)) : 'index.html';
        const type = asset
          ? assetTypes[extname(path)]
          : 'text/html; charset=utf-8';
        const content = type
          ? await frontendFile(config.frontendDirectory, path)
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
        res.writeHead(200, { 'Content-Type': type! });
        res.end(content);
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
          release: config.release,
          features: {
            ai: Boolean(config.classifierFor),
            telegram: Boolean(config.telegram),
            consent: Boolean(config.consent),
            monobankJarsExcluded: Boolean(config.monobankJarsExcluded),
          },
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/accounts') {
        const service = new Accounts(repo.db);
        json(200, {
          accounts: await service.withImpact(actor),
          suggestions: await service.suggestions(actor),
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
        const service = new Refunds(repo.db);
        json(200, {
          candidates: await service.candidates(actor, id),
          links: (await service.list(actor)).filter(
            (link) => link.debitId === id || link.creditId === id,
          ),
        });
        return;
      }
      if (req.method === 'GET' && route === '/api/transaction-details') {
        const details = await transactionDetails(
          repo.db,
          actor,
          url.searchParams.get('id') ?? '',
        );
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
        if (!['UAH', 'EUR', 'USD', 'GBP'].includes(display))
          throw new Error('invalid_display_currency');
        const preferences = reviewPreferences(
          await readAppSettings(repo.db),
          url.searchParams,
        );
        const directId = url.searchParams.get('id');
        const listed = await repo.list(actor);
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
            (url.searchParams.get('detailOnly') !== '1' &&
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
          url.searchParams.get('detailOnly') === '1'
            ? records.filter((r) =>
                transactions.some((t) => t.id === r.transaction_id),
              )
            : records;
        const priorities = Object.fromEntries(
          uah.rows.map((t) => [t.id, reviewPriority(t.convertedAmountMinor)]),
        );
        const service = new Categories(repo.db);
        const { suggestions, tags } = await service.reviewContext(
          actor,
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
              method: r.method,
              provenance: r.provenance,
              missingReason: r.missingReason,
            })),
          },
          priorities,
          historicalEstimates: (
            await historicalReporting(repo, transactions, uah)
          ).rows,
          triage: scopeRecords(
            await new TransactionTriage(repo.db, () => undefined).list(actor),
          ),
          suggestions,
          tags,
          proposals: config.classifierFor
            ? scopeRecords(
                await (await config.classifierFor(actor)).list(actor),
              )
            : [],
          replies: scopeRecords(
            [
              ...(config.telegram
                ? (await config.telegram.history(actor)).map((r) => ({
                    ...r,
                    source: 'telegram',
                    created_at: r.created_at,
                  }))
                : []),
              ...(await new PaymentExplanations(repo.db).list(actor)),
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
        const owner = url.searchParams.get('owner') || undefined;
        if (owner && owner !== 'rodion' && owner !== 'katya')
          throw new Error('invalid_owner');
        const rows = filterTransactions(
          await repo.list(owner as Owner | undefined),
          parseFilters(url.searchParams),
        );
        json(
          200,
          await convertedSpending(
            repo,
            rows,
            url.searchParams.get('display') || 'UAH',
          ),
        );
        return;
      }
      if (req.method === 'GET' && route === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(style);
        return;
      }
      if (req.method === 'GET' && route === '/health/ready') {
        await repo.db.query('SELECT 1');
        json(200, { status: 'ready', release: config.release });
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
        const target = url.searchParams.get('display') || 'UAH';
        const owner = url.searchParams.get('owner') || undefined;
        if (owner && owner !== 'rodion' && owner !== 'katya')
          throw new Error('invalid_owner');
        const rows = filterTransactions(
          await repo.list(owner as Owner | undefined),
          parseFilters(url.searchParams),
        );
        const totals = await convertedSpending(repo, rows, target);
        html(
          `<h1>Display currency</h1><p>Uses recorded bank amounts where available. Third-currency historical market rates are not configured. Original purchase amounts may exclude bank fees. Missing conversions remain outside these partial totals.</p><form method="get"><label>Currency<select name="display">${['UAH', 'EUR', 'USD', 'GBP'].map((c) => `<option ${c === target ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label>From (Europe/Riga)<input type="date" name="from" value="${escape(url.searchParams.get('from') || '')}"></label><label>Through (Europe/Riga)<input type="date" name="to" value="${escape(url.searchParams.get('to') || '')}"></label><button>Show</button></form><p class="warning">${totals.missing} transactions have no verified conversion to ${escape(target)}.</p><div class="totals"><section class="total"><h2>Covered confirmed expenses</h2><p>${money(totals.confirmedMinor, target)}</p></section><section class="total"><h2>Covered unresolved payments</h2><p>${money(totals.unresolvedMinor, target)}</p></section><section class="total"><h2>Covered pending payments</h2><p>${money(totals.pendingMinor, target)}</p></section></div>${totals.converted.map((t) => `<p>${escape(t.description)}: ${money(t.amountMinor, target)} · ${escape(t.source)}</p>`).join('')}`,
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
          `<h1>Bank connections</h1><p>Signed in as ${escape(actor)}. Approve only your own bank accounts.</p><h2>Monobank</h2><p>${config.monobankJarsExcluded ? 'Regular accounts only. Jars are excluded from future imports; any previously imported records remain visible.' : 'All API-listed regular accounts and jars are in import scope.'}</p><h2>Wise and Revolut</h2>${config.consent ? `<p>First link your accounts in Enable Banking's application settings. Then start the separate bank approval below. Keep Tailscale connected when returning here.</p><form method="post" action="/connections/enablebanking/start"><input type="hidden" name="csrf" value="${csrf}"><label>Bank<select name="bank"><option>Wise</option><option>Revolut</option></select></label><label>Country code for the bank connection<input name="country" required pattern="[A-Za-z]{2}" maxlength="2" placeholder="e.g. LV"></label><button>Start bank approval</button></form>` : '<p>Bank approval is not configured yet.</p>'}${connections.map((c) => `<section class="total"><h2>${escape(c.bank)} · ${escape(c.country)}</h2><p>${escape(c.status)} · Valid until ${escape(c.expiry)}</p></section>`).join('')}<p>Approving access does not automatically start transaction imports or classify spending.</p>`,
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
      if (req.method === 'GET' && route === '/api/ops') {
        json(200, {
          ...(await repo.health()),
          credentials: config.credentialHealth
            ? [config.credentialHealth()]
            : [],
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
        html(
          `<h1>System health</h1>${config.credentialHealth ? `<section class="total"><h2>OpenAI API key</h2><p>${escape(config.credentialHealth().state.replaceAll('_', ' '))} · Expires ${escape(config.credentialHealth().expiresOn ?? config.credentialHealth().expiresAt ?? 'date not configured')}</p><p>Replacement reminders: 5, 2 and 1 calendar days before expiry (Europe/Riga).</p></section>` : ''}<div class="totals"><section class="total"><span class="muted">Application database</span><div class="number">Ready</div><p>Connected and responding</p></section><section class="total"><span class="muted">Running release</span><div class="number">${escape(config.release.slice(0, 7))}</div><p>Use this reference when reporting a problem</p></section></div><h2>Bank imports</h2>${
            connections.length
              ? connections
                  .map((c) => {
                    const last = c.last_success_at
                      ? new Date(String(c.last_success_at))
                      : null;
                    const fresh =
                      last && Date.now() - last.getTime() <= 86400000;
                    return `<section class="total"><h2>${escape(String(c.connection).replaceAll(':', ' · ') + (/^enablebanking:(rodion|katya)$/.test(String(c.connection)) ? ' (legacy combined status)' : ''))}</h2><p>${escape(c.state)} · ${last ? (fresh ? 'Updated within 24 hours' : 'Last complete run is over 24 hours old') : 'No complete run yet'}</p>${last ? `<p>Last complete run: ${escape(last.toISOString())}</p>` : ''}${c.error_code ? `<p class="warning">${escape(advice[String(c.error_code)] ?? 'Import needs review before retrying.')}</p>` : ''}</section>`;
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
        if (
          route === '/api/payment-explanations' ||
          route === '/api/cash-transactions'
        ) {
          const explanations = new PaymentExplanations(repo.db);
          let id = form.id!;
          let revision = Number(form.revision);
          let text = form.text!;
          if (route === '/api/cash-transactions') {
            const created = await new CashTransactions(repo.db).create(actor, {
              requestId: form.requestId!,
              amount: form.amount!,
              currency: form.currency!,
              date: form.date!,
              description: form.description!,
            });
            id = created.id;
            const transaction = (await repo.list(actor)).find(
              (row) => row.id === id,
            )!;
            revision = transaction.revision;
            text = form.description!;
            const existing = (await explanations.list(actor, id)).find(
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
            classifier = await config.classifierFor?.(actor);
          } catch {
            /* Save the owner's explanation even if AI configuration is unavailable. */
          }
          const saved = await explanations.saveAndPropose(
            actor,
            {
              transactionId: id,
              revision,
              text,
              requestId: form.requestId!,
            },
            classifier,
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
            owner: actor,
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
            actor,
            form.pattern as 'routine' | 'exceptional' | 'unreviewed',
            form.reason!,
            Number(form.annotationRevision),
          );
          res.writeHead(303, { Location: '/review?all=1' });
          res.end();
          return;
        }
        if (route === '/telegram/queue') {
          if (!config.telegram) throw new Error('telegram_not_configured');
          const row = (await repo.list(actor)).find((t) => t.id === form.id);
          if (!row) throw new Error('not_found');
          await config.telegram.queue(
            row.id,
            Number(form.revision),
            `${actor}: ${row.description} (${row.amountMinor} minor units ${row.currency}, ${row.bookedAt.slice(0, 10)}). What was this payment for? Reply to this message.`,
            actor,
          );
          res.writeHead(303, { Location: '/review' });
          res.end();
          return;
        }
        if (route === '/tags') {
          const service = new Categories(repo.db);
          const current = await service.tags(actor, form.id!);
          // `tagIds` replaces the whole set, which is what a multi-select
          // editor means by saving; `tagId` keeps adding one, as the plain
          // HTML form does.
          await service.setTags(
            actor,
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
          if (bank !== 'Wise' && bank !== 'Revolut')
            throw new Error('invalid_bank');
          const target = await config.consent.start(
            actor,
            bank,
            (form.country ?? '').toUpperCase(),
          );
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
          const owner =
            config.mode === 'demo' &&
            (form.owner === 'rodion' || form.owner === 'katya')
              ? form.owner
              : actor;
          if (form.explanationId) {
            await new PaymentExplanations(repo.db).confirm(owner, {
              explanationId: form.explanationId,
              transactionId: form.id!,
              revision: Number(form.revision),
              kind: form.kind as Kind,
              category: form.category?.trim() || null,
              reason: form.reason!,
            });
          } else {
            await repo.classify(
              form.id!,
              Number(form.revision),
              {
                kind: form.kind,
                category: form.category?.trim() || null,
                reason: form.reason,
              },
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
      const owner = url.searchParams.get('owner') || undefined;
      if (owner && owner !== 'rodion' && owner !== 'katya')
        throw new Error('invalid_owner');
      const filters = parseFilters(url.searchParams);
      const rows = filterTransactions(
        await repo.list(owner as Owner | undefined),
        filters,
      );
      if (route === '/api/transactions') {
        json(200, { transactions: rows });
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
