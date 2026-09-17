// Seeds the demo workspace (data/demo) with bank connections in every state
// the Bank imports page shows, so the page can be looked at with pnpm shots.
// Stop the demo server first: PGlite is single-process. Synthetic data only.
import { memoryDatabase, migrate } from '../dist/src/database.js';
import { Repository } from '../dist/src/repository.js';
import { syncBank } from '../dist/src/bank-sync.js';
import { ConnectorError } from '../dist/src/connectors/types.js';
import { synthetic } from '../dist/src/synthetic.js';

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
      { id: 'iron', currency: 'UAH', label: 'iron' },
      { id: 'white', currency: 'UAH', label: 'white' },
      { id: 'fop', currency: 'UAH', label: 'fop' },
    ],
  }),
  connector({
    source: 'monobank',
    owner: 'katya',
    accounts: [{ id: 'black', currency: 'UAH', label: 'black' }],
    fail: 'schema',
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'wise',
    accounts: [
      { id: 'w1', currency: 'EUR', label: 'Wise EUR' },
      { id: 'w2', currency: 'USD', label: 'Wise USD' },
    ],
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'revolut',
    accounts: [{ id: 'r1', currency: 'USD', label: 'Revolut USD' }],
    payments: 1,
  }),
  connector({
    source: 'enablebanking',
    owner: 'rodion',
    bank: 'swedbank',
    accounts: [{ id: 's1', currency: 'XXX', label: 'Swedbank' }],
  }),
  connector({
    source: 'enablebanking',
    owner: 'katya',
    bank: 'wise',
    accounts: [{ id: 'kw', currency: 'EUR', label: 'Wise EUR' }],
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
