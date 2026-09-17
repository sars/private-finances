import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitcoinFromStats,
  etherFromHexWei,
  fetchBinanceSpot,
  fetchBitcoinBalance,
  fetchEthereumBalance,
  fetchFlexStatement,
  parseFlexStatement,
  signBinanceQuery,
  usdPrices,
  valueExchangeAssets,
  FeedError,
  type Fetcher,
} from '../src/holding-feeds.js';

const statementXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Positions" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U0000000" fromDate="20260917" toDate="20260917" period="LastBusinessDay" whenGenerated="20260918;041501">
<OpenPositions>
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="QQQ" position="20" markPrice="618.00" positionValue="12360" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="QQQ" position="10" markPrice="618.00" positionValue="6180" levelOfDetail="LOT" />
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="VT" position="17" markPrice="140.5" positionValue="2388.5" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U0000000" currency="EUR" assetCategory="STK" symbol="VWCE" position="3" markPrice="120" positionValue="360" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U0000000" currency="USD" assetCategory="STK" symbol="BAD" position="abc" markPrice="1" levelOfDetail="SUMMARY" />
</OpenPositions>
<CashReport>
<CashReportCurrency accountId="U0000000" currency="BASE_SUMMARY" endingCash="17205.55" levelOfDetail="SUMMARY" />
<CashReportCurrency accountId="U0000000" currency="USD" endingCash="17205.55" levelOfDetail="SUMMARY" />
<CashReportCurrency accountId="U0000000" currency="USD" endingCash="1" levelOfDetail="LOT" />
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

const reply = (body: string, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  text: async () => body,
});

test('a Flex statement yields summary positions with prices and real-currency cash only', () => {
  const statement = parseFlexStatement(statementXml);
  assert.deepEqual(
    statement.positions.map((p) => [
      p.symbol,
      p.quantity,
      p.markPrice,
      p.currency,
    ]),
    [
      ['QQQ', '20', '618.00', 'USD'],
      ['VT', '17', '140.5', 'USD'],
      ['VWCE', '3', '120', 'EUR'],
    ],
  );
  assert.deepEqual(statement.cash, [
    { currency: 'USD', endingCash: '17205.55' },
  ]);
  assert.equal(statement.fromDate, '2026-09-17');
  assert.throws(() => parseFlexStatement('<html>login</html>'), /schema/);
});

test('the Flex flow asks, waits while the statement is generated, and fails clearly on a bad token', async () => {
  const calls: string[] = [];
  let polls = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push(`${url.origin}${url.pathname}`);
    assert.equal(init.headers?.['user-agent'], 'Java');
    if (url.pathname.endsWith('SendRequest')) {
      assert.equal(url.searchParams.get('v'), '3');
      assert.equal(url.searchParams.get('q'), '1234567');
      return reply(
        '<FlexStatementResponse timestamp="x"><Status>Success</Status><ReferenceCode>987654321</ReferenceCode><Url>https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>',
      );
    }
    assert.equal(url.searchParams.get('q'), '987654321');
    polls += 1;
    if (polls === 1)
      return reply(
        '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>',
      );
    return reply(statementXml);
  };
  const statement = await fetchFlexStatement(
    '123456789012345678901234',
    '1234567',
    fetcher,
    {
      waitMs: 1,
    },
  );
  assert.equal(statement.positions.length, 3);
  assert.equal(polls, 2);
  assert.deepEqual(calls, [
    'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest',
    'https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement',
    'https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement',
  ]);
  await assert.rejects(
    fetchFlexStatement('123456789012345678901234', '1234567', async () =>
      reply(
        '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>',
      ),
    ),
    (error: unknown) =>
      error instanceof FeedError &&
      error.code === 'auth' &&
      error.detail === 'flex_1012',
  );
  await assert.rejects(
    fetchFlexStatement(
      '123456789012345678901234',
      '1234567',
      async (url) =>
        url.pathname.endsWith('SendRequest')
          ? reply(
              '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode></FlexStatementResponse>',
            )
          : reply(
              '<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>',
            ),
      { attempts: 2, waitMs: 1 },
    ),
    (error: unknown) =>
      error instanceof FeedError && error.code === 'transient',
  );
  await assert.rejects(
    fetchFlexStatement('short', '1', fetcher),
    /configuration/,
  );
  await assert.rejects(
    fetchFlexStatement('123456789012345678901234', '1234567', async () =>
      reply('', 429),
    ),
    /rate_limit/,
  );
});

test('exchange assets are valued through dollar markets, then BTC markets, and the rest is reported unpriced', () => {
  const prices = usdPrices([
    { symbol: 'BTCUSDT', price: '90000' },
    { symbol: 'ETHUSDT', price: '3000.5' },
    { symbol: 'RAREBTC', price: '0.0001' },
    { symbol: 'BNBUSDC', price: '600' },
    { symbol: 'DEADUSDT', price: '0.00000000' },
    { symbol: 'JUNK', price: 'n/a' },
  ]);
  assert.equal(prices.has('DEAD'), false);
  assert.equal(prices.get('BTC'), '90000');
  assert.equal(prices.get('USDT'), '1');
  assert.equal(prices.get('RARE'), '9');
  assert.equal(prices.get('BNB'), '600');
  const valued = valueExchangeAssets(
    [
      { asset: 'BTC', free: '0.1', locked: '0.05' },
      { asset: 'USDT', free: '250.5', locked: '0' },
      { asset: 'LDETH', free: '2', locked: '0' },
      { asset: 'NOPE', free: '5', locked: '0' },
      { asset: 'ZERO', free: '0', locked: '0' },
    ],
    prices,
  );
  assert.deepEqual(
    valued.assets.map((a) => [a.asset, a.quantity, a.usdPerUnit]),
    [
      ['BTC', '0.15', '90000'],
      ['LDETH', '2', '3000.5'],
      ['NOPE', '5', null],
      ['USDT', '250.5', '1'],
    ],
  );
  // 0.15 × 90,000 + 250.5 + 2 × 3,000.5
  assert.equal(valued.totalUsd, '19751.5');
  assert.deepEqual(valued.unpriced, ['NOPE']);
  assert.equal(
    valueExchangeAssets([{ asset: 'X', free: '1', locked: '0' }], new Map())
      .totalUsd,
    null,
  );
});

test('the exchange call is signed over its query and sends the key in the header', async () => {
  const secret = 'S'.repeat(64);
  const key = 'K'.repeat(64);
  const seen: Array<{
    path: string;
    header: string | undefined;
    query: URLSearchParams;
  }> = [];
  const fetcher: Fetcher = async (url, init) => {
    seen.push({
      path: url.pathname,
      header: init.headers?.['X-MBX-APIKEY'],
      query: url.searchParams,
    });
    if (url.pathname === '/api/v3/account')
      return reply(
        JSON.stringify({
          balances: [{ asset: 'BTC', free: '1', locked: '0' }],
        }),
      );
    return reply(JSON.stringify([{ symbol: 'BTCUSDT', price: '90000' }]));
  };
  const holdings = await fetchBinanceSpot(
    key,
    secret,
    fetcher,
    () => 1758100000000,
  );
  assert.equal(holdings.totalUsd, '90000');
  const account = seen[0]!;
  assert.equal(account.header, key);
  assert.equal(account.query.get('timestamp'), '1758100000000');
  assert.equal(account.query.get('omitZeroBalances'), 'true');
  const unsigned = new URLSearchParams(account.query);
  unsigned.delete('signature');
  assert.equal(
    account.query.get('signature'),
    signBinanceQuery(unsigned, secret),
  );
  assert.equal(seen[1]!.header, undefined);
  await assert.rejects(
    fetchBinanceSpot('short', secret, fetcher),
    /configuration/,
  );
  await assert.rejects(
    fetchBinanceSpot(key, secret, async () => reply('{}', 401)),
    /auth/,
  );
});

test('wallet balances come from public ledgers in exact units', async () => {
  assert.equal(
    bitcoinFromStats({
      chain_stats: { funded_txo_sum: 30000000, spent_txo_sum: 11825803 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
    }),
    '0.18174197',
  );
  assert.throws(
    () => bitcoinFromStats({ chain_stats: { funded_txo_sum: 'x' } }),
    /schema/,
  );
  assert.equal(etherFromHexWei('0x172869cf10b1c000'), '1.6687'); // 1.6687 ETH in wei
  assert.equal(etherFromHexWei('0x0'), '0');
  assert.throws(() => etherFromHexWei('1.6687'), /schema/);
  const btc = await fetchBitcoinBalance(
    'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxx',
    async (url) => {
      assert.equal(url.origin, 'https://mempool.space');
      return reply(
        JSON.stringify({
          chain_stats: { funded_txo_sum: 100000000, spent_txo_sum: 0 },
        }),
      );
    },
  );
  assert.equal(btc, '1');
  await assert.rejects(
    fetchBitcoinBalance('not-an-address', async () => reply('{}')),
    /configuration/,
  );
  const eth = await fetchEthereumBalance(
    '0x20bbc3DaC2F86F1d875ba017c81f50039aF47c9A',
    async (url, init) => {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body!) as {
        method: string;
        params: string[];
      };
      assert.equal(body.method, 'eth_getBalance');
      assert.equal(body.params[1], 'latest');
      assert.equal(url.origin, 'https://rpc.example.test');
      return reply(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }),
      );
    },
    'https://rpc.example.test/',
  );
  assert.equal(eth, '1');
  await assert.rejects(
    fetchEthereumBalance(
      '0x20bbc3DaC2F86F1d875ba017c81f50039aF47c9A',
      async () => reply('{}'),
      'http://insecure.test',
    ),
    /configuration/,
  );
});
