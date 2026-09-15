import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  memoryDatabase,
  postgresDatabase,
  migrate,
  type Database,
} from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Classifier } from '../src/classifier.js';
import {
  initializeLlmBudget,
  llmBudgetSummary,
  reservationCost,
} from '../src/llm-budget.js';
const model = 'gpt-5.4-mini-2026-03-17';
const config = {
  apiKey: 'synthetic',
  model,
  maxRequestsPerDay: 100,
  maxInputChars: 4000,
  maxOutputTokens: 512,
  timeoutMs: 1000,
  categories: ['Food / Groceries'],
};
const usage = {
  input_tokens: 1000,
  output_tokens: 100,
  input_tokens_details: { cached_tokens: 500 },
};
const response = (extra: Record<string, unknown> = {}) => ({
  id: 'resp_synthetic',
  status: 'completed',
  usage,
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: JSON.stringify({
            kind: 'personal_expense',
            category: 'Food / Groceries',
            confidence: 0.8,
            explanation: 'Review',
          }),
        },
      ],
    },
  ],
  ...extra,
});
async function setup(db: Database = memoryDatabase()) {
  await migrate(db);
  const repo = new Repository(db);
  const source = randomUUID();
  await repo.importBatch(
    [0, 1, 2].map((i) => ({
      source,
      sourceId: String(i),
      accountId: 'a',
      owner: i === 1 ? 'katya' : 'rodion',
      bookedAt: '2026-09-11T00:00:00Z',
      currency: 'EUR',
      amountMinor: '-100',
      description: 'Synthetic',
    })),
  );
  return { db, rows: (await repo.list()).filter((t) => t.source === source) };
}
async function seedHold(
  db: Database,
  id: string,
  amount: string,
  month?: string,
) {
  await db.query(
    "INSERT INTO classifier_proposals(id,transaction_id,revision,owner,model,state,request_key) SELECT $1,id,0,owner,$3,'failed','seed' FROM transactions WHERE id=$2",
    [
      id,
      (await db.query('SELECT id FROM transactions LIMIT 1')).rows[0]!.id,
      model,
    ],
  );
  await db.query(
    `INSERT INTO llm_cost_ledger(proposal_id,month,model,state,held_nano,input_price_nano,cached_price_nano,output_price_nano) VALUES($1,COALESCE($3,to_char(now() AT TIME ZONE 'Europe/Riga','YYYY-MM')),$2,'uncertain',$4,750,75,4500)`,
    [id, model, month ?? null, amount],
  );
}
test('full context reservation is bounded and unknown model/tier fail closed', () => {
  assert.equal(
    reservationCost({ model, service_tier: 'default', max_output_tokens: 512 }),
    302304000n,
  );
  assert.equal(
    reservationCost({
      model: 'unknown',
      service_tier: 'default',
      max_output_tokens: 512,
    }),
    null,
  );
  assert.equal(
    reservationCost({
      model,
      service_tier: 'priority',
      max_output_tokens: 512,
    }),
    null,
  );
  assert.equal(
    reservationCost({
      model,
      service_tier: 'default',
      max_output_tokens: 512,
      input: 'x'.repeat(100001),
    }),
    null,
  );
});
test('cached usage settles exact prices before invalid, incomplete or refused output validation', async () => {
  const { db, rows } = await setup();
  try {
    for (let i = 0; i < 3; i++) {
      const row = rows[i]!;
      const c = new Classifier(db, config, async (body) => {
        assert.equal(body.service_tier, 'default');
        return response(
          i === 0 ? {} : i === 1 ? { status: 'incomplete' } : { output: [] },
        );
      });
      assert.equal(
        (await c.propose(row.id, 0, row.owner)).status,
        i === 0 ? 'proposed' : 'failed',
      );
    }
    const summary = await llmBudgetSummary(db);
    assert.equal(summary.spentUsd, '0.002587500');
    assert.equal(summary.heldUsd, '0.000000000');
    assert.equal(summary.measuredRequests, 3);
    assert.equal(summary.byModel[0]!.requests, 3);
    assert.equal(JSON.stringify(summary).includes('Synthetic'), false);
  } finally {
    await db.close();
  }
});
test('missing, invalid usage and timeouts retain reservations with no blind retry', async () => {
  const { db, rows } = await setup();
  try {
    const outputs = [
      response({ usage: undefined }),
      response({ usage: { ...usage, input_tokens: -1 } }),
    ];
    for (let i = 0; i < 2; i++) {
      const row = rows[i]!;
      await new Classifier(db, config, async () => outputs[i]).propose(
        row.id,
        0,
        row.owner,
      );
    }
    const row = rows[2]!;
    let calls = 0;
    const c = new Classifier(db, { ...config, timeoutMs: 5 }, async () => {
      calls++;
      await new Promise(() => {});
    });
    assert.equal((await c.propose(row.id, 0, row.owner)).status, 'failed');
    assert.equal(
      (await c.propose(row.id, 0, row.owner)).status,
      'already_requested',
    );
    assert.equal(calls, 1);
    const summary = await llmBudgetSummary(db);
    assert.equal(summary.heldUsd, '0.906912000');
    assert.equal(summary.uncertainRequests, 3);
    assert.equal(summary.spentUsd, '0.000000000');
  } finally {
    await db.close();
  }
});
async function concurrent(db: Database) {
  const { rows } = await setup(db);
  try {
    await seedHold(db, randomUUID(), '9000000000');
    let calls = 0;
    const c = new Classifier(db, config, async () => {
      calls++;
      return response({ usage: undefined });
    });
    const results = await Promise.all(
      rows.map((row) => c.propose(row.id, 0, row.owner)),
    );
    assert.equal(calls, 1);
    assert.equal(
      results.filter((r) => r.status === 'budget_exhausted').length,
      2,
    );
    const summary = await llmBudgetSummary(db);
    assert.equal(summary.heldUsd, '9.302304000');
  } finally {
    await db.close();
  }
}
test('shared monthly reservations serialize concurrent owners near the ceiling', () =>
  concurrent(memoryDatabase()));
test(
  'PostgreSQL shared monthly reservations serialize separate connections',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = postgresDatabase(process.env.TEST_DATABASE_URL!);
    const schema = 'llm_' + randomUUID().replaceAll('-', '');
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${schema}`);
      await concurrent(postgresDatabase(url.toString()));
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);
test('prior Riga month holds do not consume current month; legacy backfill is idempotent', async () => {
  const { db, rows } = await setup();
  try {
    const old = randomUUID();
    await seedHold(db, old, '9500000000', '2020-01');
    const row = rows[0]!;
    let calls = 0;
    await new Classifier(db, config, async () => {
      calls++;
      return response();
    }).propose(row.id, 0, row.owner);
    assert.equal(calls, 1);
    const id = randomUUID();
    await db.query(
      "INSERT INTO classifier_proposals(id,transaction_id,revision,owner,model,state,request_key) VALUES($1,$2,0,$3,$4,'failed','legacy')",
      [id, row.id, row.owner, model],
    );
    await db.transaction(initializeLlmBudget);
    await db.transaction(initializeLlmBudget);
    const summary = await llmBudgetSummary(db);
    assert.equal(summary.legacyRequests, 1);
    assert.equal(summary.heldUsd, '0.318432000');
    assert.equal(summary.requestCount, 2);
  } finally {
    await db.close();
  }
});

test('unexpected service tier and usage overruns pause all future requests', async () => {
  for (const extra of [
    { service_tier: 'priority' },
    { usage: { ...usage, output_tokens: 513 } },
  ]) {
    const { db, rows } = await setup();
    try {
      let calls = 0;
      const c = new Classifier(db, config, async () => {
        calls++;
        return response(extra);
      });
      const first = rows[0]!,
        second = rows[1]!;
      await c.propose(first.id, 0, first.owner);
      assert.equal(
        (await c.propose(second.id, 0, second.owner)).status,
        'budget_exhausted',
      );
      assert.equal(calls, 1);
      const summary = await llmBudgetSummary(db);
      assert.equal(summary.state, 'paused');
      assert.equal(summary.pauseReason, 'pricing_or_usage_anomaly');
      assert.equal(summary.heldUsd, '0.302304000');
      assert.equal(summary.projectedUsd, null);
    } finally {
      await db.close();
    }
  }
});

test('Riga month boundary differs from UTC and forecast needs two full observed days', async () => {
  const { db, rows } = await setup();
  try {
    const boundary = (
      await db.query(
        `SELECT to_char('2026-09-30T21:30:00Z'::timestamptz AT TIME ZONE 'Europe/Riga','YYYY-MM') AS month`,
      )
    ).rows[0]!;
    assert.equal(boundary.month, '2026-10');
    const row = rows[0]!;
    await new Classifier(db, config, async () => response()).propose(
      row.id,
      0,
      row.owner,
    );
    assert.equal((await llmBudgetSummary(db)).projectedUsd, null);
    await db.query(
      "UPDATE llm_budget_metadata SET tracking_started_at=now()-interval '3 days'",
    );
    const day = Number(
      (
        await db.query(
          "SELECT extract(day FROM now() AT TIME ZONE 'Europe/Riga') AS day",
        )
      ).rows[0]!.day,
    );
    if (day >= 3)
      assert.notEqual((await llmBudgetSummary(db)).projectedUsd, null);
    await seedHold(db, randomUUID(), '9300000000');
    const summary = await llmBudgetSummary(db);
    assert.equal(summary.state, 'paused');
    assert.equal(summary.pauseReason, 'monthly_budget');
  } finally {
    await db.close();
  }
});
