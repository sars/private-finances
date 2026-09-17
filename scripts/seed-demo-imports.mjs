// Seeds the demo workspace (data/demo) with bank connections in every state
// the Bank imports page shows, so the page can be looked at with pnpm shots.
// Stop the demo server first: PGlite is single-process. Synthetic data only.
import { memoryDatabase, migrate } from '../dist/src/database.js';
import { Repository } from '../dist/src/repository.js';
import { syncBank } from '../dist/src/bank-sync.js';
import { ConnectorError } from '../dist/src/connectors/types.js';
import { synthetic } from '../dist/src/synthetic.js';
import { FxRates } from '../dist/src/fx-rates.js';

const db = memoryDatabase('data/demo');
await migrate(db);
const repo = new Repository(db);

function connector({ source, owner, bank, accounts, fail, payments = 3 }) {
  return {
    source,
    owner,
    ...(bank ? { bank } : {}),
    accounts: async () =>
      accounts.map((a) => ({
        source,
        owner,
        accountId: `${source}:${owner}:${a.id}`,
        providerAccountId: a.id,
        currency: a.currency,
        label: a.label,
        // Stated with the listing, as Monobank states it. An account left
        // without one demonstrates a bank that will not say.
        ...(a.balance === undefined
          ? {}
          : {
              balance: {
                currency: a.currency === 'XXX' ? 'EUR' : a.currency,
                amountMinor: a.balance,
                ...(a.creditLimit ? { creditLimitMinor: a.creditLimit } : {}),
              },
            }),
      })),
    transactions: async (account) => {
      if (fail) throw new ConnectorError(fail);
      return synthetic.slice(0, payments).map((t, i) => ({
        ...t,
        id: `${account.accountId}-${i}`,
        sourceId: `${account.accountId}-${i}`,
        source,
        owner,
        accountId: account.accountId,
        currency: account.currency === 'XXX' ? 'EUR' : account.currency,
        status: 'booked',
        sourceDetails: {},
      }));
    },
  };
}

const from = new Date(Date.now() - 31 * 86400000);
const to = new Date();
const runs = [
  connector({
    source: 'monobank',
    owner: 'rodion',
    accounts: [
      { id: 'iron', currency: 'UAH', label: 'iron', balance: '3435539' },
      { id: 'white', currency: 'UAH', label: 'white', balance: '-128400', creditLimit: '2000000' },
      { id: 'fop', currency: 'UAH', label: 'fop', balance: '881205' },
    ],
  }),
  connector({
    source: 'monobank',
    owner: 'katya',
    accounts: [{ id: 'black', currency: 'UAH', label: 'black', balance: '1704322' }],
    fail: 'schema',
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'wise',
    accounts: [
      { id: 'w1', currency: 'EUR', label: 'Wise EUR', balance: '245080' },
      { id: 'w2', currency: 'USD', label: 'Wise USD', balance: '61233' },
    ],
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'revolut',
    accounts: [{ id: 'r1', currency: 'USD', label: 'Revolut USD', balance: '12905' }],
    payments: 1,
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'swedbank',
    accounts: [{ id: 's1', currency: 'XXX', label: 'Swedbank', balance: '1590744' }],
  }),
  connector({
    source: 'enablebanking',
    owner: 'katya',
    bank: 'wise',
    accounts: [{ id: 'kw', currency: 'EUR', label: 'Wise EUR', balance: '78650' }],
    fail: 'rate_limit',
  }),
];
for (const c of runs) {
  try {
    await syncBank(repo, c, from, to);
  } catch {
    // A failed connection is part of the picture.
  }
}
// Daily rates, so the demo can show a household total in one currency rather
// than only the warning that says it could not. Synthetic figures, and the
// same shape the real feed writes.
const rates = new FxRates(db);
for (let back = 0; back < 3; back++) {
  const asOf = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
  for (const [base, rate] of [
    ['USD', '41.50'],
    ['EUR', '48.20'],
    ['GBP', '55.10'],
  ]) {
    try {
      await rates.insert({
        source: 'demo',
        base,
        target: 'UAH',
        rate,
        asOf,
        retrievedAt: `${asOf}T12:00:00.000Z`,
        version: 1,
        provenance: 'synthetic demo rate',
      });
    } catch {
      // Already seeded.
    }
  }
}
await db.query(
  `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status) VALUES
   ('rodion','Wise','LV','s1',now(),now()+interval '4 days','authorized'),
   ('rodion','Revolut','LV','s2',now(),now()+interval '1 day','authorized'),
   ('rodion','Swedbank','LV','s3',now(),now()+interval '9 days','authorized'),
   ('rodion','LHV Pank','EE','s4',now(),now()+interval '10 days','authorized'),
   ('katya','Wise','LV','s5',now(),now()-interval '1 day','authorized')
   ON CONFLICT(owner,bank) DO NOTHING`,
);
await db.close();
console.log('seeded');
