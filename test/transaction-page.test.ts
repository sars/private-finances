import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, type Transaction } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { SpendingPatterns } from '../src/spending-pattern.js';
import { Refunds } from '../src/refunds.js';
import { FxRates } from '../src/fx-rates.js';
import { filterTransactions, parseFilters } from '../src/filters.js';
import { needsSpendingReview } from '../src/spending-review.js';
import {
  hiddenByReviewPreferences,
  readAppSettings,
  reviewPreferences,
} from '../src/app-settings.js';
import {
  pageTransactions,
  parsePageQuery,
  rigaDayStart,
} from '../src/transaction-page.js';
import { web } from '../src/web.js';

/**
 * The paged endpoint must select exactly the rows the in-memory pipeline
 * selects, in the same order, however the page is cut. So the expected set is
 * always computed by the existing functions over `repo.list()`, and the SQL
 * has to agree with them.
 */
async function seed(repo: Repository) {
  const db = repo.db;
  const rows: Record<string, string>[] = [];
  let i = 0;
  const add = (
    owner: 'rodion' | 'katya',
    amountMinor: string,
    bookedAt: string,
    extra: Partial<{
      currency: string;
      description: string;
      status: 'booked' | 'pending';
    }> = {},
  ) =>
    rows.push({
      source: 'synthetic',
      sourceId: 'p' + i++,
      accountId: owner + '-card',
      owner,
      currency: extra.currency ?? 'UAH',
      amountMinor,
      description: extra.description ?? `Synthetic shop ${i}`,
      bookedAt,
      status: extra.status ?? 'booked',
    });
  // Either side of a Riga midnight (UTC+3 at the end of August).
  add('rodion', '-1000', '2026-08-31T20:59:59Z', { description: 'Late Rimi' });
  add('rodion', '-1100', '2026-08-31T21:00:00Z', { description: 'Early Rimi' });
  // A moment shared by three payments, so the keyset has to break ties by id.
  for (const owner of ['rodion', 'katya', 'rodion'] as const)
    add(owner, '-500', '2026-09-05T09:00:00Z', { description: 'Tied Wolt' });
  add('katya', '-7000', '2026-09-06T10:00:00Z', {
    currency: 'EUR',
    description: 'Katya IKEA',
  });
  add('katya', '4000', '2026-09-08T10:00:00Z', {
    currency: 'EUR',
    description: 'IKEA refund',
  });
  add('rodion', '-2500', '2026-09-07T10:00:00Z', {
    description: 'Fully refunded jacket',
  });
  add('rodion', '2500', '2026-09-09T10:00:00Z', {
    description: 'Jacket refund',
  });
  add('rodion', '0', '2026-09-09T11:00:00Z', { description: 'Card check' });
  add('rodion', '-300', '2026-09-10T08:00:00Z', {
    status: 'pending',
    description: 'Hold at Narvesen',
  });
  add('rodion', '-900', '2026-09-10T09:00:00Z', {
    currency: 'GBP',
    description: 'London coffee',
  });
  add('katya', '-1500', '2026-09-11T09:00:00Z', { description: 'Katya taxi' });
  add('rodion', '50000', '2026-09-12T09:00:00Z', { description: 'Salary' });
  for (let n = 0; n < 20; n++)
    add(
      n % 2 ? 'katya' : 'rodion',
      String(-100 - n),
      `2026-07-${String(1 + n).padStart(2, '0')}T12:00:00Z`,
      { description: n % 3 ? 'Circle K' : 'Maxima' },
    );
  await repo.importBatch(rows);
  const all = await repo.list();
  const byDescription = (d: string) =>
    all
      .filter((t) => t.description === d)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const categories = new Categories(db);
  const nodes = await categories.listNodes();
  const leaf = nodes.find((n) => n.assignable && n.path.includes(' / '))!;
  const otherLeaf = nodes.find(
    (n) =>
      n.assignable &&
      n.path !== leaf.path &&
      !n.path.startsWith(leaf.path.split(' / ')[0]!),
  )!;
  const decide = async (
    t: Transaction,
    kind: string,
    category: string | null,
  ) =>
    repo.classify(
      t.id,
      t.revision,
      { kind, category, reason: 'synthetic decision' },
      t.owner,
    );
  const [lateRimi] = byDescription('Late Rimi');
  const [earlyRimi] = byDescription('Early Rimi');
  await decide(lateRimi!, 'personal_expense', leaf.path);
  await decide(earlyRimi!, 'personal_expense', otherLeaf.path);
  for (const t of all.filter((t) => t.description === 'Maxima'))
    await decide(t, 'personal_expense', leaf.path);
  await decide(byDescription('Salary')[0]!, 'non_personal', null);
  await decide(byDescription('Card check')[0]!, 'internal_transfer', null);
  await decide(
    byDescription('Katya taxi')[0]!,
    'personal_expense',
    'Unspecified',
  );
  const patterns = new SpendingPatterns(db);
  const refreshed = await repo.list();
  const jacket = refreshed.find(
    (t) => t.description === 'Fully refunded jacket',
  )!;
  await patterns.set(
    jacket.id,
    jacket.revision,
    'rodion',
    'exceptional',
    'synthetic',
  );
  const tag = await categories.saveTag('holiday');
  const katyaIkea = refreshed.find((t) => t.description === 'Katya IKEA')!;
  await categories.setTags('katya', katyaIkea.id, [tag.id]);
  const refunds = new Refunds(db);
  await refunds.link({
    debitId: jacket.id,
    creditId: refreshed.find((t) => t.description === 'Jacket refund')!.id,
    expectedDebitRevision: jacket.revision,
    expectedCreditRevision: 0,
    owner: 'rodion',
    reason: 'synthetic full refund',
  });
  await refunds.link({
    debitId: katyaIkea.id,
    creditId: refreshed.find((t) => t.description === 'IKEA refund')!.id,
    expectedDebitRevision: katyaIkea.revision,
    expectedCreditRevision: 0,
    owner: 'katya',
    reason: 'synthetic partial refund',
  });
  await db.query(
    `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,transaction_id)
     VALUES($1,'rodion','chat',1,'file','matched',$2)`,
    [randomUUID(), lateRimi!.id],
  );
  await new FxRates(db).insert({
    source: 'synthetic-market',
    base: 'EUR',
    target: 'UAH',
    rate: '50',
    asOf: '2026-09-06',
    retrievedAt: '2026-09-07T00:00:00Z',
    version: 1,
    provenance: 'Synthetic daily rate',
  });
  return { leaf, otherLeaf, tag };
}

/** What the in-memory pipeline says the query should list, in list order. */
async function expected(repo: Repository, query: string) {
  const params = new URLSearchParams(query);
  const owner = params.get('owner') as 'rodion' | 'katya' | null;
  const preferences = reviewPreferences(await readAppSettings(repo.db), params);
  const listed = await repo.list(owner ?? undefined);
  const hiddenRefunds = new Set(
    preferences.hideRefunds
      ? listed
          .filter(
            (t) =>
              t.refund?.role === 'refund' &&
              t.refund.reductions.every((item) => item.discrepancy === null),
          )
          .map((t) => t.id)
      : [],
  );
  const kinds = params.get('kinds')?.split(',');
  const q = params.get('q')?.toLowerCase();
  return filterTransactions(listed, parseFilters(params))
    .filter(
      (t) =>
        !hiddenByReviewPreferences(t, preferences) &&
        !hiddenRefunds.has(t.id) &&
        (params.get('review') !== '1' || needsSpendingReview(t, true, true)) &&
        (!kinds || kinds.includes(t.kind)) &&
        (!q || t.description.toLowerCase().includes(q)),
    )
    .map((t) => t.id);
}

async function paged(repo: Repository, query: string, limit: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let total = -1;
  for (let guard = 0; guard < 100; guard++) {
    const params = new URLSearchParams(query);
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const page = await pageTransactions(
      repo,
      parsePageQuery(params),
      reviewPreferences(await readAppSettings(repo.db), params),
    );
    if (total === -1) total = page.total;
    else assert.equal(page.total, total, 'total is stable across pages');
    assert.ok(page.transactions.length <= limit);
    ids.push(...page.transactions.map((t) => t.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { ids, total };
}

test('a Riga day starts at the right instant either side of the clock change', () => {
  assert.equal(rigaDayStart('2026-08-31'), '2026-08-30T21:00:00.000Z');
  assert.equal(rigaDayStart('2026-12-01'), '2026-11-30T22:00:00.000Z');
  // The night the clocks go back: the day still begins at Riga midnight.
  assert.equal(rigaDayStart('2026-10-25'), '2026-10-24T21:00:00.000Z');
  assert.equal(rigaDayStart('2026-10-26'), '2026-10-25T22:00:00.000Z');
});

test('every page of the SQL list agrees with the in-memory filters, in order', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const { leaf, tag } = await seed(repo);
  const branch = leaf.path.split(' / ')[0]!;
  const queries = [
    '',
    'owner=rodion',
    'owner=katya',
    'review=1',
    'review=1&owner=katya',
    'from=2026-09-01',
    'to=2026-08-31',
    'from=2026-09-05&to=2026-09-05',
    `category=${encodeURIComponent(leaf.path)}`,
    `category=${encodeURIComponent(branch)}`,
    'pattern=exceptional',
    'pattern=unreviewed&owner=rodion',
    'scope=spending',
    'scope=excluded&includeNonPersonal=1&includeTransfers=1',
    'scope=unresolved',
    'kinds=personal_expense,non_personal&includeNonPersonal=1',
    'q=rimi',
    'q=IKEA',
    'currency=EUR',
    'includeRefunds=1',
    'includeZeroAmount=1',
    'includeZeroAmount=1&includeRefunds=1&includeNonPersonal=1&includeTransfers=1',
    'includeZeroAmount=0&includeRefunds=0',
  ];
  try {
    for (const query of queries) {
      const want = await expected(repo, query);
      for (const limit of [3, 7, 200]) {
        const got = await paged(repo, query, limit);
        assert.deepEqual(got.ids, want, `${query} with pages of ${limit}`);
        assert.equal(got.total, want.length, `${query} total`);
        assert.equal(new Set(got.ids).size, got.ids.length, `${query} unique`);
      }
    }
    // The side filters that the in-memory pipeline never had.
    const all = await repo.list();
    const tagged = (await paged(repo, `tag=${tag.id}`, 50)).ids;
    assert.deepEqual(
      tagged,
      all.filter((t) => t.description === 'Katya IKEA').map((t) => t.id),
    );
    const withReceipt = (await paged(repo, 'receipts=with', 50)).ids;
    assert.deepEqual(
      withReceipt,
      all.filter((t) => t.description === 'Late Rimi').map((t) => t.id),
    );
    const withRefund = (
      await paged(repo, 'refunds=with&includeRefunds=1&includeZeroAmount=1', 50)
    ).ids;
    assert.deepEqual(
      new Set(
        all.filter((t) => withRefund.includes(t.id)).map((t) => t.description),
      ),
      new Set([
        'Katya IKEA',
        'IKEA refund',
        'Fully refunded jacket',
        'Jacket refund',
      ]),
    );
    // The household default hides the credit and the purchase that came to nothing.
    const defaults = (await paged(repo, '', 50)).ids;
    for (const hidden of [
      'Jacket refund',
      'Fully refunded jacket',
      'Card check',
      'Salary',
    ])
      assert.ok(
        !all
          .filter((t) => t.description === hidden)
          .some((t) => defaults.includes(t.id)),
        `${hidden} is hidden by default`,
      );
    // The review list: unresolved outflows, the hold, the root catch-all; not income, not decided rows.
    const reviewIds = (await paged(repo, 'review=1', 50)).ids;
    const review = all.filter((t) => reviewIds.includes(t.id));
    assert.ok(review.some((t) => t.description === 'Hold at Narvesen'));
    assert.ok(review.some((t) => t.description === 'Katya taxi'));
    assert.ok(!review.some((t) => t.description === 'Salary'));
    assert.ok(!review.some((t) => t.description === 'Late Rimi'));
    assert.ok(review.every((t) => BigInt(t.amountMinor) < 0n));
  } finally {
    await db.close();
  }
});

test('the amount range compares what a payment finally cost, in the display currency', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await seed(repo);
  try {
    const preferences = reviewPreferences(
      await readAppSettings(db),
      new URLSearchParams(),
    );
    const run = (query: string) =>
      pageTransactions(
        repo,
        parsePageQuery(new URLSearchParams(query)),
        preferences,
      );
    // Katya's IKEA purchase: 70.00 EUR less a 40.00 EUR refund = 30.00 EUR, at 50 = 1,500.00 UAH.
    const around = await run('display=UAH&min=149000&max=151000');
    assert.deepEqual(
      around.transactions.map((t) => t.description),
      ['Katya IKEA'],
    );
    assert.equal(around.total, 1);
    assert.equal(around.reporting?.currency, 'UAH');
    assert.equal(around.reporting?.rows[0]?.netAmountMinor, '-150000');
    // The gross 70.00 EUR would be 3,500.00 UAH; that is not what it cost.
    const gross = await run('display=UAH&min=340000&max=360000');
    assert.equal(gross.total, 0);
    // A payment without a conversion (GBP has no rate) never satisfies a bound.
    const everything = await run('display=UAH&min=0');
    assert.ok(!everything.transactions.some((t) => t.currency === 'GBP'));
    assert.ok(everything.total > 10);
    // Paging through an amount-filtered list is the same keyset walk.
    const first = await run('display=UAH&min=0&limit=5');
    assert.equal(first.transactions.length, 5);
    assert.ok(first.nextCursor);
    const second = await run(
      `display=UAH&min=0&limit=5&cursor=${first.nextCursor}`,
    );
    assert.equal(second.transactions[0]!.id, everything.transactions[5]!.id);
    assert.equal(second.total, everything.total);
  } finally {
    await db.close();
  }
});

test('the endpoint pages the household, enriches only the page and rejects bad grammar', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const { tag } = await seed(repo);
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}/api/transactions`;
  const get = async (query: string) => {
    const response = await fetch(`${base}?${query}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    const page = await get(
      'display=UAH&limit=4&includeRefunds=1&includeZeroAmount=1',
    );
    assert.equal(page.status, 200);
    assert.equal(page.body.transactions.length, 4);
    assert.equal(typeof page.body.total, 'number');
    assert.ok(page.body.nextCursor);
    assert.equal(page.body.reporting.currency, 'UAH');
    assert.equal(page.body.reporting.rows.length, 4);
    assert.ok(Array.isArray(page.body.historicalEstimates));
    assert.ok(Array.isArray(page.body.triage));
    // Both members' payments, each with its tags looked up under its own owner.
    const owners = new Set(
      page.body.transactions.map((t: Transaction) => t.owner),
    );
    assert.deepEqual(owners, new Set(['rodion', 'katya']));
    const ikea = await get(`tag=${tag.id}&display=EUR`);
    assert.equal(ikea.body.transactions.length, 1);
    assert.equal(ikea.body.transactions[0].owner, 'katya');
    assert.deepEqual(
      ikea.body.tags[ikea.body.transactions[0].id].map(
        (t: { name: string }) => t.name,
      ),
      ['holiday'],
    );
    assert.ok(ikea.body.suggestions[ikea.body.transactions[0].id]);
    const receipted = await get('receipts=with');
    assert.equal(receipted.body.receipts[receipted.body.transactions[0].id], 1);
    // The whole list walks out through the cursor without repeats.
    const seen = new Set<string>();
    let cursor = '';
    let total = 0;
    do {
      const step = await get(`limit=6${cursor ? '&cursor=' + cursor : ''}`);
      total = step.body.total;
      for (const t of step.body.transactions) {
        assert.ok(!seen.has(t.id));
        seen.add(t.id);
      }
      cursor = step.body.nextCursor ?? '';
    } while (cursor);
    assert.equal(seen.size, total);
    assert.equal(seen.size, (await expected(repo, '')).length);
    // Only the signed-in member when asked, as the review screen does by default.
    const mine = await get('owner=rodion&review=1');
    assert.ok(
      mine.body.transactions.every((t: Transaction) => t.owner === 'rodion'),
    );
    assert.equal(
      mine.body.total,
      (await expected(repo, 'owner=rodion&review=1')).length,
    );
    for (const bad of [
      'owner=someone',
      'kinds=purchase',
      'cursor=not-a-uuid',
      'limit=0',
      'limit=500',
      'limit=abc',
      'min=100',
      'min=abc&display=UAH',
      'min=300&max=100&display=UAH',
      'receipts=maybe',
      'refunds=maybe',
      'tag=holiday',
      'display=uah',
      'from=2026-13-01',
    ])
      assert.equal((await get(bad)).status, 400, bad);
    assert.equal((await get('review=1')).status, 200);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await db.close();
  }
});
