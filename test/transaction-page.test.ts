import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTransactionDetails } from '../src/transaction-details.js';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { web } from '../src/web.js';

const { accountIdentity, accountToneClasses } = await import(
  new URL('../../frontend/src/lib/account-identity.ts', import.meta.url).href
);
const { bookedMoment } = await import(
  new URL('../../frontend/src/lib/transactions.ts', import.meta.url).href
);
const { searchMatch } = await import(
  new URL('../../frontend/src/lib/search-match.ts', import.meta.url).href
);

const mono = {
  id: 'synthetic',
  source: 'monobank',
  amount_minor: '-16219',
  currency: 'UAH',
  status: 'booked',
  description: 'Synthetic purchase',
  account_label: 'Monobank black',
};

test('the review page is handed named bank facts, not a label list it has to parse', () => {
  const { summary } = projectTransactionDetails({
    ...mono,
    source_details: {
      counterName: 'Synthetic recipient',
      counterIban: 'UA123456789012345678901234567',
      comment: 'Synthetic purpose',
      mcc: 5812,
      operationAmount: -350,
      currencyCode: 978,
      cashbackAmount: 120,
    },
  });
  assert.equal(summary.counterparty.role, 'Recipient');
  assert.equal(summary.counterparty.name, 'Synthetic recipient');
  assert.equal(summary.counterparty.iban, 'UA12 •••• 4567');
  assert.equal(summary.counterparty.card, null);
  assert.equal(summary.purpose, 'Synthetic purpose');
  assert.equal(summary.mcc?.code, '5812');
  assert.equal(summary.mcc?.meaning, 'Eating places and restaurants');
  assert.equal(summary.originalAmount, '−3.50 EUR');
  assert.equal(summary.cashback, '1.20 UAH');
});

test('an original amount in the account currency says nothing, so it is left out of the formatted view', () => {
  const result = projectTransactionDetails({
    ...mono,
    source_details: { operationAmount: -16219, currencyCode: 980 },
  });
  assert.equal(result.summary.originalAmount, null);
  // It stays in the complete field list, which is the bank record as sent.
  assert.ok(
    result.fields.some(
      (field) =>
        field.label === 'Original purchase amount' &&
        field.value === '−162.19 UAH',
    ),
  );
});

test('an Enable Banking record carries its purpose, type and value date', () => {
  const { summary } = projectTransactionDetails({
    id: 'synthetic',
    source: 'enablebanking',
    amount_minor: '-4500',
    currency: 'EUR',
    status: 'booked',
    description: 'Synthetic card payment',
    account_label: 'Revolut EUR',
    source_details: {
      creditor: { name: 'Synthetic merchant' },
      creditor_account: { iban: 'LT123456789012345678' },
      creditor_agent: { name: 'Synthetic bank' },
      remittance_information: ['Order 42'],
      bank_transaction_code: { description: 'Card payment' },
      value_date: '2026-09-02',
    },
  });
  assert.equal(summary.counterparty.name, 'Synthetic merchant');
  assert.equal(summary.counterparty.bank, 'Synthetic bank');
  assert.equal(summary.purpose, 'Order 42');
  assert.equal(summary.bankTransactionType, 'Card payment');
  assert.equal(summary.valueDate, '2026-09-02');
});

test('an account is recognisable from what the owner named it, not only from the connector', () => {
  assert.equal(
    accountIdentity('monobank', 'UAH', 'Monobank black').tone,
    'ink',
  );
  assert.equal(
    accountIdentity('monobank', 'UAH', 'Monobank white').tone,
    'paper',
  );
  assert.equal(
    accountIdentity('enablebanking', 'USD', 'Revolut USD').tone,
    'violet',
  );
  assert.equal(accountIdentity('manual_cash', 'UAH', null).tone, 'amber');
  assert.equal(accountIdentity('manual_cash', 'UAH', null).name, 'Cash');
  assert.equal(accountIdentity('monobank', 'EUR', '').name, 'Monobank');
  // The owner banks with Revolut, not with the aggregator that fetched the row,
  // so the integration's name never reaches a label or a tooltip.
  const aggregated = accountIdentity('enablebanking', 'USD', '');
  assert.equal(aggregated.name, 'USD account');
  assert.ok(!/enable/i.test(aggregated.name + aggregated.detail));
  const revolut = accountIdentity('enablebanking', 'USD', 'Revolut USD');
  assert.equal(revolut.name, 'Revolut USD');
  assert.ok(!/enable/i.test(revolut.name + revolut.detail));
  // The currency is not repeated when the owner's own name already says it.
  assert.equal(revolut.detail, '');
  assert.equal(
    accountIdentity('monobank', 'EUR', 'Black card').detail,
    'Monobank · EUR',
  );
  assert.equal(
    accountIdentity('monobank', 'UAH', 'Monobank black').icon,
    'card',
  );
  assert.equal(accountIdentity('manual_cash', 'UAH', null).icon, 'cash');
  // Every tone a chip can carry has to have a look defined for it.
  for (const source of ['monobank', 'enablebanking', 'manual_cash', 'other'])
    for (const label of ['', 'Monobank black', 'Revolut USD', 'Біла картка'])
      assert.ok(
        accountToneClasses[accountIdentity(source, 'UAH', label).tone],
        `${source} ${label}`,
      );
});

test('a card payment shows its clock time; a statement line only claims a day', () => {
  const card = bookedMoment('2026-09-14T18:45:00.000Z', 'monobank');
  assert.equal(card.day, '14 Sept 2026');
  assert.equal(card.time, '21:45');
  assert.equal(
    bookedMoment('2026-09-14T18:45:00.000Z', 'enablebanking').time,
    null,
  );
  assert.equal(
    bookedMoment('2026-09-14T00:00:00.000Z', 'manual_cash').time,
    null,
  );
  // An unparseable timestamp is shown as it arrived rather than invented.
  assert.equal(bookedMoment('not a date', 'monobank').day, 'not a date');
  assert.equal(bookedMoment('not a date', 'monobank').time, null);
});

test('the tag editor saves the whole set, while the plain form still adds one', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'a',
      accountId: 'a',
      owner: 'rodion',
      amountMinor: '-100',
      currency: 'UAH',
      bookedAt: '2026-08-01T12:00:00Z',
      description: 'Synthetic payment',
    },
  ]);
  const payment = (await repo.list('rodion'))[0]!;
  const categories = new Categories(db);
  const groceries = await categories.saveTag('Groceries');
  const gift = await categories.saveTag('Gift');
  const trip = await categories.saveTag('Trip');
  const config = { port: 0, mode: 'demo' as const, release: 'test' };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  const names = async () =>
    (await categories.tags('rodion', payment.id)).map((tag) => tag.name).sort();
  try {
    const bootstrap = (await (await fetch(base + '/api/bootstrap')).json()) as {
      csrf: string;
    };
    const post = (values: Record<string, string>) =>
      fetch(base + '/tags', {
        method: 'POST',
        body: new URLSearchParams({ csrf: bootstrap.csrf, ...values }),
        redirect: 'manual',
      });
    await post({ id: payment.id, tagId: groceries.id });
    await post({ id: payment.id, tagId: gift.id });
    assert.deepEqual(await names(), ['Gift', 'Groceries']);
    // The editor saves what it shows, so a tag it dropped has to disappear.
    await post({ id: payment.id, tagIds: [groceries.id, trip.id].join(',') });
    assert.deepEqual(await names(), ['Groceries', 'Trip']);
    // Removing the last tag is a real save, not an empty request to ignore.
    await post({ id: payment.id, tagIds: '' });
    assert.deepEqual(await names(), []);
  } finally {
    // `fetch` keeps its sockets alive, so closing waits forever without this.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test('a category search shows what was typed, and ranks a leading match first', () => {
  const groceries = (search: string) =>
    searchMatch('Food / Groceries', search, ['Food', 'Groceries']);
  const parking = (search: string) =>
    searchMatch('Transport / Car / Parking', search, [
      'Transport',
      'Car',
      'Parking',
    ]);
  // What the owner types has to appear; a loose letter sequence is not a match.
  assert.ok(groceries('groc') > 0);
  assert.equal(parking('groc'), 0);
  assert.ok(parking('park') > 0);
  // Every word must be found, so a second word narrows rather than widens.
  assert.ok(groceries('food groc') > 0);
  assert.equal(groceries('food parking'), 0);
  // A match at the start outranks one buried in the middle.
  assert.ok(groceries('food') > groceries('roceries'));
  // An empty search keeps everything, and case never decides.
  assert.equal(groceries('   '), 1);
  assert.ok(groceries('GROCERIES') > 0);
});
