// Puts a handful of import attempts into the demo database so the runs screens
// can be looked at before they ship. Development only; never run on the server.
//
//   node scripts/seed-demo-runs.mjs   then pnpm demo, then pnpm shots /imports/runs
import { memoryDatabase, migrate } from '../dist/src/database.js';
import { randomUUID } from 'node:crypto';

const db = memoryDatabase('data/demo');
await migrate(db);

const now = Date.now();
const connections = [
  ['enablebanking:rodion:swedbank', 'Swedbank'],
  ['enablebanking:rodion:wise', 'Wise'],
  ['monobank:rodion', 'Monobank'],
  ['enablebanking:katya:revolut', 'Revolut'],
];
for (const [connection] of connections)
  await db.query(
    `INSERT INTO bank_sync_runs(connection,state,last_success_at)
     VALUES($1,'succeeded',now()) ON CONFLICT(connection) DO NOTHING`,
    [connection],
  );
await db.query(
  `UPDATE bank_sync_runs SET state='failed', error_code='rate_limit',
     retry_after=$1::timestamptz, retry_reason='rate_limit'
   WHERE connection='enablebanking:rodion:swedbank'`,
  [new Date(now + 3 * 3600000).toISOString()],
);

let made = 0;
for (let i = 0; i < 38; i++) {
  const [connection] = connections[i % connections.length];
  const started = new Date(now - i * 2100000);
  const swedbank = connection.endsWith('swedbank');
  const failed = swedbank && i < 8;
  const ms = failed ? 900 : 1400 + (i % 5) * 300;
  const steps = [{ stage: 'claim', at: 2 }];
  if (failed) {
    steps.push({
      stage: 'request',
      at: 120,
      ms: 740,
      path: '/accounts/…/transactions',
      status: 429,
      code: 'rate_limit',
      retryAfterMs: 43200000,
    });
    steps.push({ stage: 'error', at: 880, code: 'rate_limit', retryAfterMs: 43200000 });
  } else {
    steps.push({
      stage: 'request',
      at: 40,
      ms: 310,
      path: '/sessions/…',
      status: 200,
    });
    steps.push({ stage: 'accounts', at: 360, ms: 320, count: 2, note: 'listed' });
    steps.push({
      stage: 'request',
      at: 700,
      ms: 210,
      path: '/accounts/…/balances',
      status: 200,
    });
    steps.push({ stage: 'balance', at: 720, ms: 215, account: 'demo-account' });
    steps.push({
      stage: 'request',
      at: 960,
      ms: 380,
      path: '/accounts/…/transactions',
      status: 200,
    });
    steps.push({
      stage: 'transactions',
      at: 1340,
      ms: 385,
      account: 'demo-account',
      count: 12 + (i % 7),
      note: 'fetched',
    });
    steps.push({
      stage: 'commit',
      at: 1500,
      ms: 60,
      account: 'demo-account',
      count: i % 4,
      note: 'written',
    });
    steps.push({ stage: 'finish', at: ms, count: i % 4 });
  }
  await db.query(
    `INSERT INTO bank_sync_attempts(id,connection,started_at,finished_at,from_at,to_at,outcome,error_code,accounts,changed,steps)
     VALUES($1,$2,$3::timestamptz,$4::timestamptz,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11::jsonb)`,
    [
      randomUUID(),
      connection,
      started.toISOString(),
      new Date(started.getTime() + ms).toISOString(),
      new Date(started.getTime() - 31 * 86400000).toISOString(),
      started.toISOString(),
      failed ? 'failed' : 'succeeded',
      failed ? 'rate_limit' : null,
      failed ? 0 : 2,
      failed ? 0 : i % 4,
      JSON.stringify(steps),
    ],
  );
  made++;
}
await db.close();
console.log(`seeded ${made} demo import runs`);
