import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { restPlacements } from '../src/resting-place.js';
import { expenseSummary } from '../src/domain.js';

/**
 * The resting place (ADR 0008, decision C7). The owner would not review
 * hundreds of undecided payments, so a payment on an account they have marked
 * personal comes to rest on the best category its evidence supports, counted
 * but flagged as nobody's decision.
 *
 * These tests exist mostly to prove what the sweep refuses to touch, because
 * that is where the damage would be.
 */

const base = {
  source: 'synthetic',
  accountId: 'personal',
  owner: 'rodion' as const,
  bookedAt: '2026-08-01T10:00:00Z',
  currency: 'EUR',
  amountMinor: '-1000',
  description: 'Some merchant',
};

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
     VALUES('synthetic','personal','rodion','Everyday','personal'),
           ('synthetic','unreviewed','rodion','Unknown','unreviewed'),
           ('synthetic','business','rodion','Work','business')`,
  );
  return { db, repo: new Repository(db) };
}

const sweep = (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.transaction((tx) => restPlacements(tx));

test('ADR 0008 an undecided payment rests on the leaf its merchant code implies', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'groceries', sourceDetails: { mcc: 5411 } },
    ]);
    const report = await sweep(db);
    assert.equal(report.byMcc, 1);
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'personal_expense');
    assert.equal(row.category, 'Food / Groceries');
    assert.equal(row.provisional, true, 'placed, not decided');
    assert.equal(row.classificationSource, 'mcc');
    const history = await repo.history(row.id);
    assert.ok(
      history.some(
        (event) =>
          event.actor === 'resting_place' && event.event === 'auto_classified',
      ),
      'the placement says why it landed there',
    );
  } finally {
    await db.close();
  }
});

test('ADR 0008 a transfer code says nothing, so the payment rests in the catch-all', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      // 4829 is a money-transfer rail, not a purchase: exactly the owner's
      // "just an IBAN transfer with no comments" case.
      { ...base, sourceId: 'transfer', sourceDetails: { mcc: 4829 } },
      { ...base, sourceId: 'nothing' },
    ]);
    const report = await sweep(db);
    assert.equal(report.byDefault, 2);
    assert.equal(report.byMcc, 0);
    for (const row of await repo.list()) {
      assert.equal(row.category, 'Unspecified');
      assert.equal(row.classificationSource, 'default');
      assert.equal(row.provisional, true);
    }
  } finally {
    await db.close();
  }
});

test('ADR 0008 the sweep never touches a decision a person made', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'decided', sourceDetails: { mcc: 5411 } },
    ]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'internal_transfer',
        category: null,
        reason: 'Moving my own money',
      },
      'rodion',
    );
    const report = await sweep(db);
    assert.equal(report.byMcc, 0);
    const after = (await repo.list())[0]!;
    assert.equal(after.kind, 'internal_transfer');
    assert.equal(after.provisional, false);
    assert.equal(after.classificationSource, 'human');
  } finally {
    await db.close();
  }
});

test('ADR 0008 a person may deliberately leave a payment unresolved', async () => {
  // The hard case for the sweep. This payment looks exactly like an undecided
  // one — kind `unresolved`, a merchant code that maps cleanly — but a person
  // chose that state, and an existing invariant says a human decision wins.
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'deliberately-open', sourceDetails: { mcc: 5411 } },
    ]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'unresolved',
        category: null,
        reason: 'I need to check what this was',
      },
      'rodion',
    );
    const report = await sweep(db);
    assert.equal(report.byMcc, 0);
    assert.equal(
      report.skipped.human_decision,
      1,
      'reported as declined, so the figure explains itself',
    );
    const after = (await repo.list())[0]!;
    assert.equal(after.kind, 'unresolved');
    assert.equal(after.provisional, false);
  } finally {
    await db.close();
  }
});

test('ADR 0008 an account nobody has described is left alone', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'unknown-account',
        accountId: 'unreviewed',
        sourceDetails: { mcc: 5411 },
      },
      // A business account is not personal spending either, and its own policy
      // already classified this one.
      { ...base, sourceId: 'work', accountId: 'business' },
    ]);
    const report = await sweep(db);
    assert.equal(report.byMcc, 0);
    assert.equal(report.byDefault, 0);
    const rows = await repo.list();
    const unreviewed = rows.find((r) => r.sourceId === 'unknown-account')!;
    assert.equal(
      unreviewed.kind,
      'unresolved',
      '"a personal account holds personal spending" says nothing about an undescribed one',
    );
    assert.equal(unreviewed.provisional, false);
  } finally {
    await db.close();
  }
});

// A payment the bank is still holding used to belong in this list. It no longer
// does: the money has already left, so it is swept like any other outflow. That
// is held in holds-are-spending.test.ts.
test('ADR 0008 money coming in and cash entered by hand are not swept', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'incoming', amountMinor: '5000' },
      {
        ...base,
        source: 'manual_cash',
        sourceId: 'cash',
        sourceDetails: { mcc: 5411 },
      },
    ]);
    await db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
       VALUES('manual_cash','personal','rodion','Cash','personal')
       ON CONFLICT DO NOTHING`,
    );
    const report = await sweep(db);
    assert.equal(report.byMcc + report.byDefault + report.identified, 0);
    for (const row of await repo.list())
      assert.equal(row.kind, 'unresolved', row.sourceId);
  } finally {
    await db.close();
  }
});

test('ADR 0008 a receipt adds evidence rather than holding a payment back', async () => {
  // The owner's correction: a receipt "is just additional source for
  // categorisation". An earlier version held receipted payments out of the
  // totals until the photograph had been read, which is the opposite of what
  // they asked for. The payment is counted now, and the receipt lane improves
  // the answer afterwards because a provisional placement is an automatic
  // decision, which it revisits.
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'with-receipt', sourceDetails: { mcc: 5411 } },
    ]);
    const row = (await repo.list())[0]!;
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,transaction_id)
       VALUES($1,'rodion','chat',1,'file','matched',$2)`,
      [randomUUID(), row.id],
    );
    const report = await sweep(db);
    assert.equal(report.byMcc, 1, 'the receipt does not delay counting it');
    const placed = (await repo.list())[0]!;
    assert.equal(placed.kind, 'personal_expense');
    assert.equal(placed.category, 'Food / Groceries');
    assert.equal(
      placed.provisional,
      true,
      'still nobody’s decision, so the receipt lane may improve it',
    );
    // And it remains eligible for that improvement: the receipt lane looks at
    // unresolved and personal_expense alike, excluding only human decisions.
    const eligible = await db.query(
      `SELECT count(*)::int AS count FROM transactions t
       WHERE t.kind IN ('unresolved','personal_expense')
         AND NOT EXISTS(SELECT 1 FROM audit_events h
                        WHERE h.transaction_id=t.id AND h.event='classified')
         AND EXISTS(SELECT 1 FROM receipt_jobs r
                    WHERE r.transaction_id=t.id AND r.state='matched')`,
    );
    assert.equal(Number(eligible.rows[0]!.count), 1);
  } finally {
    await db.close();
  }
});

test('ADR 0008 a pending explanation keeps its turn', async () => {
  // The owner is mid-way through saying what this payment was, so answering it
  // for them would be rude and probably wrong.
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'being-explained', sourceDetails: { mcc: 5411 } },
    ]);
    const row = (await repo.list())[0]!;
    await db.query(
      `INSERT INTO transaction_explanations(id,transaction_id,revision,owner,input_text,status,request_id)
       VALUES($1,$2,$3,'rodion','It was the sports club, not groceries','pending',$4)`,
      [randomUUID(), row.id, row.revision, randomUUID()],
    );
    const report = await sweep(db);
    assert.equal(report.byMcc, 0);
    assert.equal(report.skipped.pending_explanation, 1);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('ADR 0008 the sweep is idempotent and provisional money is counted but reported', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'one', sourceDetails: { mcc: 5411 } },
      { ...base, sourceId: 'two', amountMinor: '-2500' },
    ]);
    const first = await sweep(db);
    assert.equal(first.byMcc + first.byDefault, 2);
    const second = await sweep(db);
    assert.equal(
      second.byMcc + second.byDefault + second.identified,
      0,
      'a placed payment is no longer undecided, so a second run changes nothing',
    );

    const summary = expenseSummary(await repo.list()).byCurrency[0]!;
    // The owner's ask: the money is in the total.
    assert.equal(summary.personalExpenseMinor, '3500');
    assert.equal(summary.unresolvedOutflowMinor, '0');
    // And the uncertainty is still visible beside it.
    assert.equal(summary.provisionalOutflowMinor, '3500');
    assert.equal(summary.provisionalCount, 2);
  } finally {
    await db.close();
  }
});

test('ADR 0008 deciding a placed payment settles it', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'placed', sourceDetails: { mcc: 5411 } },
    ]);
    await sweep(db);
    const placed = (await repo.list())[0]!;
    assert.equal(placed.provisional, true);
    await repo.classify(
      placed.id,
      placed.revision,
      {
        kind: 'personal_expense',
        category: 'Food / Restaurants / Dining in',
        reason: 'It was lunch',
      },
      'rodion',
    );
    const decided = (await repo.list())[0]!;
    assert.equal(decided.provisional, false);
    assert.equal(decided.classificationSource, 'human');
    assert.equal(decided.category, 'Food / Restaurants / Dining in');
    const summary = expenseSummary(await repo.list()).byCurrency[0]!;
    assert.equal(summary.provisionalOutflowMinor, '0');
    assert.equal(summary.personalExpenseMinor, '1000');
  } finally {
    await db.close();
  }
});

test('ADR 0008 a registered household counterparty settles the kind outright', async () => {
  const { db, repo } = await setup();
  try {
    const { identifierHashFor } = await import('../src/accounts.js');
    const iban = 'LV80BANK0000435195001';
    await db.query(
      `INSERT INTO own_accounts(source,account_id,owner,label,purpose,identifier_hash)
       VALUES('synthetic','katya-savings','katya','Savings','personal',$1)`,
      [identifierHashFor({ scheme: 'iban', value: iban })],
    );
    await repo.importBatch([
      {
        ...base,
        sourceId: 'to-katya',
        sourceDetails: { counterIban: iban, mcc: 5411 },
      },
    ]);
    const report = await sweep(db);
    assert.equal(report.identified, 1);
    assert.equal(report.byMcc, 0, 'identity outranks a category guess');
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'internal_transfer');
    assert.equal(
      row.provisional,
      false,
      'a registered account is evidence, not a guess',
    );
    assert.equal(row.classificationSource, 'identity');
    // And it leaves the spending total, because the money never left the
    // household.
    assert.equal(
      expenseSummary(await repo.list()).byCurrency[0]!.personalExpenseMinor,
      '0',
    );
  } finally {
    await db.close();
  }
});
