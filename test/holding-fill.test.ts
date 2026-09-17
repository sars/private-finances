import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Holdings } from '../src/holdings.js';
import { AccountBalances } from '../src/account-balances.js';
import {
  applyExchangeHoldings,
  applyFlexStatement,
  fillFromBalances,
  fillWallets,
  isLastThursday,
  rigaDate,
  runFeeds,
} from '../src/holding-fill.js';
import { parseImportDocument, importHoldings } from '../src/holdings-import.js';
import type { Fetcher } from '../src/holding-feeds.js';
import { parseArguments } from '../src/holdings-snapshot-cli.js';

const reply = (body: string, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  text: async () => body,
});

test('bank holdings take the stored balance less the overdraft, and stale or missing balances are skipped by reason', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    assert.equal(
      (await db.query('SELECT version FROM schema_versions WHERE version=54'))
        .rows.length,
      1,
    );
    const service = new Holdings(db);
    const card = await service.upsert('rodion', {
      name: 'Card UAH',
      kind: 'bank',
      denomination: 'UAH',
      invested: false,
      liquid: true,
      feed: 'bank',
      feedRef: 'monobank|mono:rodion:card',
    });
    await service.upsert('rodion', {
      name: 'Old card',
      kind: 'bank',
      denomination: 'EUR',
      invested: false,
      liquid: true,
      feed: 'bank',
      feedRef: 'enablebanking|old',
    });
    await service.upsert('rodion', {
      name: 'Sleepy account',
      kind: 'bank',
      denomination: 'USD',
      invested: false,
      liquid: true,
      feed: 'bank',
      feedRef: 'enablebanking|sleepy',
    });
    for (const [overrides, error] of [
      [{ feed: 'carrier' }, /holding_invalid_feed/],
      [{ feed: 'bank', feedRef: 'no-separator' }, /holding_invalid_feed_ref/],
      [{ feed: 'wallet', feedRef: '' }, /holding_invalid_feed_ref/],
    ] as const)
      await assert.rejects(
        service.upsert('rodion', {
          name: 'Broken',
          kind: 'bank',
          denomination: 'USD',
          invested: false,
          liquid: true,
          ...overrides,
        }),
        error,
      );
    const balances = new AccountBalances(db);
    // Balance 53,000 UAH with a 20,000 overdraft counted inside it.
    await balances.record(
      { source: 'monobank', accountId: 'mono:rodion:card' },
      [
        {
          currency: 'UAH',
          amountMinor: '5300000',
          creditLimitMinor: '2000000',
        },
      ],
      new Date('2026-09-24T07:00:00Z'),
    );
    await balances.record(
      { source: 'enablebanking', accountId: 'sleepy' },
      [{ currency: 'USD', amountMinor: '100000' }],
      new Date('2026-09-10T07:00:00Z'),
    );
    const summary = await fillFromBalances(
      db,
      '2026-09-24',
      new Date('2026-09-24T08:05:00Z'),
    );
    assert.deepEqual(summary, {
      filled: 1,
      unchanged: 0,
      skipped: { no_balance: 1, balance_stale: 1 },
      pricesRecorded: 0,
      created: 0,
    });
    const report = await service.report('UAH', '2026-09-24');
    const row = report.rows.find((r) => r.holding.id === card.id)!;
    assert.equal(row.quantity, '33000');
    assert.equal(row.source, 'bank');
    const again = await fillFromBalances(
      db,
      '2026-09-24',
      new Date('2026-09-24T08:06:00Z'),
    );
    assert.equal(again.filled, 0);
    assert.equal(again.unchanged, 1);
  } finally {
    await db.close();
  }
});

test('the broker statement fills positions and cash, zeroes what was sold, creates new positions and records prices', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const service = new Holdings(db);
    const qqq = await service.upsert('rodion', {
      name: 'QQQ',
      kind: 'broker',
      denomination: 'QQQ',
      invested: true,
      liquid: true,
      group: 'Broker',
      owner: 'rodion',
      feed: 'ibkr',
    });
    const sold = await service.upsert('rodion', {
      name: 'ARKK',
      kind: 'broker',
      denomination: 'ARKK',
      invested: true,
      liquid: true,
      group: 'Broker',
      feed: 'ibkr',
    });
    const cash = await service.upsert('rodion', {
      name: 'Broker cash',
      kind: 'broker',
      denomination: 'USD',
      invested: true,
      liquid: true,
      group: 'Broker',
      feed: 'ibkr',
      feedRef: 'CASH',
    });
    const summary = await applyFlexStatement(db, '2026-09-24', {
      positions: [
        {
          symbol: 'QQQ',
          quantity: '20',
          markPrice: '618',
          currency: 'USD',
          assetCategory: 'STK',
        },
        {
          symbol: 'VT',
          quantity: '17',
          markPrice: '140.5',
          currency: 'USD',
          assetCategory: 'STK',
        },
      ],
      cash: [{ currency: 'USD', endingCash: '17205.55' }],
      sections: [],
      fromDate: null,
      toDate: null,
    });
    assert.deepEqual(summary, {
      filled: 4,
      unchanged: 0,
      skipped: {},
      pricesRecorded: 2,
      created: 1,
    });
    const report = await service.report('USD', '2026-09-24');
    const by = (id: string) => report.rows.find((r) => r.holding.id === id)!;
    assert.equal(by(qqq.id).quantity, '20');
    assert.equal(by(qqq.id).valueMinor, '1236000');
    assert.equal(by(sold.id).quantity, '0');
    assert.equal(by(cash.id).quantity, '17205.55');
    const created = report.rows.find((r) => r.holding.denomination === 'VT')!;
    assert.equal(created.holding.name, 'Broker VT');
    assert.equal(created.holding.owner, 'rodion');
    assert.equal(created.holding.feed, 'ibkr');
    assert.equal(created.valueMinor, '238850');
    assert.equal(report.totals.totalMinor, '3195405'); // 12,360 + 2,388.50 + 17,205.55
  } finally {
    await db.close();
  }
});

test('the exchange total lands on the holding that asks for it and wallets are read by address', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const service = new Holdings(db);
    const total = await service.upsert('rodion', {
      name: 'Exchange all',
      kind: 'crypto',
      denomination: 'USD',
      invested: true,
      liquid: true,
      feed: 'binance',
      feedRef: 'TOTAL',
    });
    const coin = await service.upsert('rodion', {
      name: 'Exchange ETH',
      kind: 'crypto',
      denomination: 'ETH',
      invested: true,
      liquid: true,
      feed: 'binance',
      feedRef: 'ETH',
    });
    const wrong = await service.upsert('rodion', {
      name: 'Exchange total in euro',
      kind: 'crypto',
      denomination: 'EUR',
      invested: true,
      liquid: true,
      feed: 'binance',
    });
    const exchange = await applyExchangeHoldings(db, '2026-09-24', {
      assets: [
        { asset: 'BTC', quantity: '0.15', usdPerUnit: '90000' },
        { asset: 'ETH', quantity: '2', usdPerUnit: '3000' },
      ],
      totalUsd: '19500',
      unpriced: [],
    });
    assert.deepEqual(exchange, {
      filled: 2,
      unchanged: 0,
      skipped: { total_needs_usd: 1 },
      pricesRecorded: 2,
      created: 0,
    });
    const btcWallet = await service.upsert('rodion', {
      name: 'Cold BTC',
      kind: 'crypto',
      denomination: 'BTC',
      invested: true,
      liquid: true,
      feed: 'wallet',
      feedRef: 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    const ethWallet = await service.upsert('rodion', {
      name: 'Cold ETH',
      kind: 'crypto',
      denomination: 'ETH',
      invested: true,
      liquid: true,
      feed: 'wallet',
      feedRef: '0x20bbc3DaC2F86F1d875ba017c81f50039aF47c9A',
    });
    const fetcher: Fetcher = async (url) => {
      if (url.pathname === '/api/v3/ticker/price')
        return reply(
          JSON.stringify([
            { symbol: 'BTCUSDT', price: '90000' },
            { symbol: 'ETHUSDT', price: '3000' },
          ]),
        );
      if (url.origin === 'https://mempool.space')
        return reply(
          JSON.stringify({
            chain_stats: { funded_txo_sum: 18174197, spent_txo_sum: 0 },
          }),
        );
      if (url.origin === 'https://rpc.example.test')
        return reply(JSON.stringify({ result: '0x172869cf10b1c000' }));
      return reply('', 500);
    };
    const wallets = await fillWallets(db, '2026-09-24', fetcher, {
      ethRpcUrl: 'https://rpc.example.test',
    });
    assert.deepEqual(wallets, {
      filled: 2,
      unchanged: 0,
      skipped: {},
      pricesRecorded: 2,
      created: 0,
    });
    const report = await service.report('USD', '2026-09-24');
    const by = (id: string) => report.rows.find((r) => r.holding.id === id)!;
    assert.equal(by(total.id).quantity, '19500');
    assert.equal(by(coin.id).quantity, '2');
    assert.equal(by(coin.id).valueMinor, '600000');
    assert.equal(by(wrong.id).quantity, null);
    assert.equal(by(btcWallet.id).quantity, '0.18174197');
    assert.equal(by(btcWallet.id).valueMinor, '1635678'); // 0.18174197 × 90,000 = 16,356.7773
    assert.equal(by(ethWallet.id).quantity, '1.6687');
    assert.equal(by(ethWallet.id).source, 'wallet');
    // A failing ledger skips its wallet with a reason and leaves the rest alone.
    const failing = await fillWallets(db, '2026-09-25', async () =>
      reply('', 503),
    );
    assert.deepEqual(failing.skipped, { wallet_transient: 2 });
    assert.equal(failing.filled, 0);
  } finally {
    await db.close();
  }
});

test('the full run reports each feed separately and a prepared document can link existing holdings to their feeds', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const document = parseImportDocument({
      holdings: [
        {
          name: 'Cold BTC',
          denomination: 'BTC',
          kind: 'crypto',
          invested: true,
          liquid: true,
        },
        {
          name: 'Exchange all',
          denomination: 'USD',
          kind: 'crypto',
          invested: true,
          liquid: true,
        },
      ],
      snapshots: [],
      prices: [],
    });
    await importHoldings(db, document);
    const linked = await importHoldings(
      db,
      parseImportDocument({
        holdings: [
          {
            name: 'Cold BTC',
            denomination: 'BTC',
            kind: 'crypto',
            invested: true,
            liquid: true,
            feed: 'wallet',
            feedRef: 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxx',
          },
          {
            name: 'Exchange all',
            denomination: 'USD',
            kind: 'crypto',
            invested: true,
            liquid: true,
            feed: 'binance',
            feedRef: 'TOTAL',
          },
        ],
        snapshots: [],
        prices: [],
      }),
    );
    assert.equal(linked.holdingsLinked, 2);
    assert.equal(linked.holdingsCreated, 0);
    const holdings = await new Holdings(db).list();
    assert.equal(holdings.find((h) => h.name === 'Cold BTC')!.feed, 'wallet');
    assert.equal(holdings.find((h) => h.name === 'Exchange all')!.revision, 1);
    const fetcher: Fetcher = async (url) => {
      if (url.pathname === '/api/v3/ticker/price')
        return reply(JSON.stringify([{ symbol: 'BTCUSDT', price: '90000' }]));
      if (url.origin === 'https://mempool.space')
        return reply(
          JSON.stringify({
            chain_stats: { funded_txo_sum: 100000000, spent_txo_sum: 0 },
          }),
        );
      return reply('', 500);
    };
    const outcomes = await runFeeds(
      db,
      '2026-09-24',
      { binance: { key: 'K'.repeat(64), secret: 'S'.repeat(64) } },
      fetcher,
    );
    assert.deepEqual(
      outcomes.map((o) => [o.feed, o.status, 'code' in o ? o.code : undefined]),
      [
        ['bank', 'ok', undefined],
        ['ibkr', 'not_configured', undefined],
        ['binance', 'failed', 'transient'],
        ['wallet', 'ok', undefined],
      ],
    );
    const wallet = outcomes.find((o) => o.feed === 'wallet')!;
    assert.equal(wallet.status === 'ok' && wallet.summary.filled, 1);
    assert.match(rigaDate(new Date('2026-09-24T21:30:00Z')), /^2026-09-2[45]$/);
    assert.equal(rigaDate(new Date('2026-09-24T22:30:00Z')), '2026-09-25');
    assert.equal(parseArguments(['2026-09-01']).asOf, '2026-09-01');
    assert.equal(parseArguments(['--check']).check, true);
    assert.equal(
      parseArguments(['--when=last-thursday']).lastThursdayOnly,
      true,
    );
    assert.throws(() => parseArguments(['--when=friday']), /usage/);
    // September 2026 ends on a Wednesday, so its last Thursday is the 24th.
    assert.equal(isLastThursday('2026-09-24'), true);
    assert.equal(isLastThursday('2026-09-17'), false);
    assert.equal(isLastThursday('2026-09-25'), false);
    assert.equal(isLastThursday('2026-10-29'), true);
    assert.equal(isLastThursday('2026-02-26'), true);
    assert.throws(() => parseArguments(['2099-01-01']), /invalid_date/);
    assert.throws(() => parseArguments(['a', 'b']), /usage/);
  } finally {
    await db.close();
  }
});
