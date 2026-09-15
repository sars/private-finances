import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Accounts } from '../src/accounts.js';
import { expenseSummary } from '../src/domain.js';
import { convertedSpending } from '../src/analytics.js';
import { Classifier } from '../src/classifier.js';
import { TransactionTriage } from '../src/transaction-triage.js';
const input = {
  source: 'synthetic',
  accountId: 'a',
  sourceId: 'one',
  owner: 'rodion',
  bookedAt: '2026-09-12T12:00:00Z',
  currency: 'EUR',
  amountMinor: '-100',
  description: 'Synthetic merchant',
};
const config = {
  apiKey: 'synthetic',
  model: 'gpt-5.4-mini-2026-03-17',
  maxRequestsPerDay: 4,
  maxInputChars: 4000,
  maxOutputTokens: 512,
  timeoutMs: 1000,
  categories: ['Food / Groceries'],
};
const response = {
  status: 'completed',
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
            confidence: 0.99,
            explanation: 'Synthetic purchase',
          }),
        },
      ],
    },
  ],
};
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([input]);
  return { db, repo, accounts: new Accounts(db), row: (await repo.list())[0]! };
}

test('account exclusions apply reversibly without altering bank records or saved human classifications', async () => {
  const { db, repo, accounts, row } = await setup();
  try {
    await repo.classify(
      row.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Owner classification',
      },
      'rodion',
    );
    const before = (
      await db.query('SELECT * FROM transactions WHERE id=$1', [row.id])
    ).rows[0];
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'a',
        owner: 'rodion',
        label: 'Work account',
        purpose: 'business',
      },
      'rodion',
    );
    await db.query(
      'ALTER TABLE own_accounts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0',
    );
    await db.query(
      "UPDATE own_accounts SET revision=7 WHERE source='synthetic' AND account_id='a'",
    );
    const business = (await repo.list())[0]!;
    // The owner said this payment was personal spending, so the account's
    // purpose does not overrule them: not everything on a business card is
    // business spending, and only a person can say which.
    assert.equal(business.kind, 'personal_expense');
    assert.equal(business.category, 'Food / Groceries');
    assert.deepEqual(business.storedClassification, {
      kind: 'personal_expense',
      category: 'Food / Groceries',
    });
    assert.equal(business.spendingPolicy?.reason, 'business_account');
    assert.equal(business.spendingPolicy?.accountLabel, 'Work account');
    assert.equal(business.spendingPolicy?.accountRevision, 7);
    assert.equal(
      expenseSummary([business]).byCurrency[0]!.personalExpenseMinor,
      '100',
    );
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'a',
        owner: 'rodion',
        label: 'Investment account',
        purpose: 'investment',
      },
      'rodion',
    );
    assert.equal((await repo.list())[0]!.kind, 'personal_expense');
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'a',
        owner: 'rodion',
        label: 'Personal account',
        purpose: 'personal',
      },
      'rodion',
    );
    const personal = (await repo.list())[0]!;
    assert.equal(personal.kind, 'personal_expense');
    assert.equal(personal.category, 'Food / Groceries');
    assert.equal(personal.spendingPolicy?.excluded, false);
    assert.deepEqual(
      (await db.query('SELECT * FROM transactions WHERE id=$1', [row.id]))
        .rows[0],
      before,
    );
  } finally {
    await db.close();
  }
});

test('pending excluded accounts stay visible but do not create spending, pending totals or missing personal FX coverage', async () => {
  const { db, repo, accounts } = await setup();
  try {
    await repo.importBatch([
      { ...input, sourceId: 'one', status: 'pending' },
      {
        ...input,
        sourceId: 'other-owner',
        accountId: 'other',
        owner: 'katya',
        currency: 'USD',
        status: 'pending',
      },
    ]);
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'a',
        owner: 'rodion',
        label: 'Work',
        purpose: 'business',
      },
      'rodion',
    );
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'other',
        owner: 'katya',
        label: 'Investments',
        purpose: 'investment',
      },
      'katya',
    );
    const rows = await repo.list();
    assert.equal(rows.length, 2);
    assert.ok(
      expenseSummary(rows).byCurrency.every(
        (c) =>
          c.pendingCount === 0 &&
          c.pendingOutflowMinor === '0' &&
          c.unresolvedCount === 0,
      ),
    );
    const fx = await convertedSpending(repo, rows, 'EUR');
    assert.equal(fx.rows.length, 2);
    assert.equal(fx.pendingMinor, '0');
    assert.equal(fx.confirmedMinor, '0');
    assert.ok(
      fx.rows.every(
        (r) => r.counted === 'excluded' && r.spendingPolicy?.excluded,
      ),
    );
    assert.deepEqual(fx.coverage.pending, { converted: 0, missing: 0 });
    assert.deepEqual(fx.coverage.confirmed, { converted: 0, missing: 0 });
    assert.equal(
      fx.rows.find((r) => r.originalCurrency === 'USD')!.status,
      'missing',
    );
  } finally {
    await db.close();
  }
});

test('account policy matches owner and provider, never a coincident account ID', async () => {
  const { db, repo } = await setup();
  try {
    await db.query(
      "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','katya','Foreign owner','business'),('other-provider','a','rodion','Other provider','investment')",
    );
    const row = (await repo.list('rodion'))[0]!;
    assert.equal(row.kind, 'unresolved');
    assert.equal(row.spendingPolicy?.excluded, false);
    assert.equal(row.spendingPolicy?.accountLabel, null);
  } finally {
    await db.close();
  }
});

test('excluded accounts spend no classifier budget and never enter personal triage', async () => {
  const { db, repo, accounts, row } = await setup();
  try {
    let calls = 0;
    for (const purpose of ['business', 'investment']) {
      await accounts.upsert(
        {
          source: 'synthetic',
          accountId: 'a',
          owner: 'rodion',
          label: 'Excluded',
          purpose,
        },
        'rodion',
      );
      const classifier = new Classifier(db, config, async () => {
        calls++;
        return response;
      });
      assert.equal(
        (await classifier.propose(row.id, 0, 'rodion')).status,
        'stale',
      );
      const triage = new TransactionTriage(db, () => classifier, undefined, {
        autoCategorizeClearExpenses: true,
      });
      assert.equal(await triage.processOne(), false);
      assert.deepEqual(await triage.list('rodion'), []);
    }
    assert.equal(calls, 0);
    assert.equal(
      (await db.query('SELECT * FROM classifier_proposals')).rows.length,
      0,
    );
    assert.equal(
      (await db.query('SELECT kind FROM transactions WHERE id=$1', [row.id]))
        .rows[0]!.kind,
      'investment',
    );
  } finally {
    await db.close();
  }
});

test('an account exclusion changed during a model request invalidates its response', async () => {
  const { db, accounts, row } = await setup();
  try {
    const classifier = new Classifier(db, config, async () => {
      await accounts.upsert(
        {
          source: 'synthetic',
          accountId: 'a',
          owner: 'rodion',
          label: 'Now work',
          purpose: 'business',
        },
        'rodion',
      );
      return response;
    });
    assert.equal(
      (await classifier.propose(row.id, 0, 'rodion')).status,
      'stale',
    );
    assert.equal(
      (await db.query('SELECT state FROM classifier_proposals')).rows[0]!.state,
      'stale',
    );
  } finally {
    await db.close();
  }
});

test('saved personal labels on excluded accounts do not train merchant context', async () => {
  const { db, repo, accounts, row } = await setup();
  try {
    await repo.classify(
      row.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Old owner label',
      },
      'rodion',
    );
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'a',
        owner: 'rodion',
        label: 'Work',
        purpose: 'business',
      },
      'rodion',
    );
    await repo.importBatch([
      { ...input, sourceId: 'new', accountId: 'personal' },
    ]);
    const target = (await repo.list()).find((r) => r.sourceId === 'new')!;
    const classifier = new Classifier(db, config, async (body) => {
      const content = (body.input as { role: string; content: string }[]).find(
        (i) => i.role === 'user',
      )!.content;
      assert.deepEqual(
        JSON.parse(content).bankContext.previousOwnerDecisions,
        [],
      );
      return response;
    });
    assert.equal(
      (await classifier.propose(target.id, 0, 'rodion')).status,
      'proposed',
    );
  } finally {
    await db.close();
  }
});

test('a manual investment on a business card keeps its attribution without admitting other payments into spending', async () => {
  const { db, repo, accounts } = await setup();
  try {
    await repo.importBatch([
      {
        ...input,
        sourceId: 'bond',
        owner: 'katya',
        accountId: 'white',
        amountMinor: '-250000',
      },
      {
        ...input,
        sourceId: 'work',
        owner: 'katya',
        accountId: 'white',
        amountMinor: '-5000',
      },
    ]);
    await accounts.upsert(
      {
        source: 'synthetic',
        accountId: 'white',
        owner: 'katya',
        label: 'Work card',
        purpose: 'business',
      },
      'katya',
    );
    const before = (await repo.list('katya')).find(
      (r) => r.sourceId === 'bond',
    )!;
    assert.equal(before.kind, 'non_personal');
    await assert.rejects(
      repo.classify(
        before.id,
        before.revision,
        { kind: 'investment', category: null, reason: 'Wrong owner' },
        'rodion',
      ),
      /not_found/,
    );
    await repo.classify(
      before.id,
      before.revision,
      {
        kind: 'investment',
        category: null,
        reason: 'Owner confirms personal bond purchase from work card',
      },
      'katya',
    );
    const rows = await repo.list('katya');
    const bond = rows.find((r) => r.sourceId === 'bond')!;
    assert.equal(bond.kind, 'investment');
    assert.equal(bond.spendingPolicy?.excluded, true);
    assert.equal(bond.spendingPolicy?.reason, 'business_account');
    assert.equal(rows.find((r) => r.sourceId === 'work')!.kind, 'non_personal');
    assert.equal(expenseSummary(rows).byCurrency[0]!.personalExpenseMinor, '0');
    const fx = await convertedSpending(repo, rows, 'EUR');
    assert.equal(fx.confirmedMinor, '0');
    assert.ok(fx.rows.every((r) => r.counted === 'excluded'));
    const history = await repo.history(bond.id);
    assert.ok(
      history.some((e) => e.actor === 'katya' && e.event === 'classified'),
    );
    // A provider correction preserves the human decision and exclusion.
    await repo.importBatch([
      {
        ...input,
        sourceId: 'bond',
        owner: 'katya',
        accountId: 'white',
        amountMinor: '-250000',
        description: 'Corrected bank description',
      },
    ]);
    assert.equal(
      (await repo.list('katya')).find((r) => r.sourceId === 'bond')!.kind,
      'investment',
    );
    const current = (await repo.list('katya')).find(
      (r) => r.sourceId === 'bond',
    )!;
    await repo.classify(
      current.id,
      current.revision,
      {
        kind: 'personal_expense',
        category: 'Unspecified',
        reason: 'Change stored decision',
      },
      'katya',
    );
    const changed = (await repo.list('katya')).find(
      (r) => r.sourceId === 'bond',
    )!;
    // Changing the stored decision changes the ledger, because the decision is
    // the ledger now. Nothing is quietly reinterpreted when the figure is drawn.
    assert.equal(changed.kind, 'personal_expense');
    assert.equal(changed.spendingPolicy?.excluded, false);
    assert.equal(changed.storedClassification?.kind, 'personal_expense');
  } finally {
    await db.close();
  }
});
