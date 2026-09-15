import { TransactionTriage } from '../src/transaction-triage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { Receipts } from '../src/receipts.js';
import { ReceiptCategorization } from '../src/receipt-categorization.js';
import { loadReceiptEvidence } from '../src/receipt-evidence.js';

async function setup(status = 'pending') {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'one',
      accountId: 'account',
      owner: 'rodion',
      bookedAt: '2026-09-12T12:00:00Z',
      currency: 'EUR',
      amountMinor: '-2200',
      description: 'Synthetic sports venue',
      status,
    },
  ]);
  const row = (await db.query('SELECT * FROM transactions')).rows[0]!;
  const receipt = randomUUID();
  await db.query(
    "INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,transaction_id,extraction) VALUES($1,'katya','1',1,'synthetic','matched',$2,$3)",
    [
      receipt,
      row.id,
      JSON.stringify({
        isReceipt: true,
        merchant: 'Synthetic cafe',
        date: '2026-09-12',
        amountMinor: '2200',
        currency: 'EUR',
        items: ['Drink', 'Cup deposit'],
      }),
    ],
  );
  return { db, repo, row, receipt };
}
const answer = {
  kind: 'personal_expense' as const,
  category: 'Food / Groceries',
  confidence: 0.96,
  explanation:
    'Receipt supports a food and drink purchase; exact drink unknown.',
};
test('shared receipt categorizes pending debit once, preserves amounts and is invalidated when moved', async () => {
  const { db, row, receipt, repo } = await setup();
  try {
    let calls = 0;
    const worker = new ReceiptCategorization(db, () => ({
      async propose(_id, _rev, owner, _text, key) {
        calls++;
        assert.equal(owner, 'rodion');
        assert.match(key!, /^receipt:v1:[a-f0-9]{64}$/);
        return { status: 'proposed', id: randomUUID(), proposal: answer };
      },
    }));
    assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), false);
    assert.equal(calls, 1);
    const fingerprint = (await loadReceiptEvidence(db, String(row.id)))!.key;
    await new Receipts(db).attach('rodion', receipt, String(row.id));
    assert.equal(
      (await loadReceiptEvidence(db, String(row.id)))!.key,
      fingerprint,
    );
    assert.equal(await worker.processOne(), false);
    let current = (
      await db.query('SELECT * FROM transactions WHERE id=$1', [row.id])
    ).rows[0]!;
    assert.equal(current.category, 'Food / Groceries');
    assert.equal(current.status, 'pending');
    assert.equal(String(current.amount_minor), '-2200');
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'two',
        accountId: 'account',
        owner: 'rodion',
        bookedAt: '2026-09-12T13:00:00Z',
        currency: 'EUR',
        amountMinor: '-2200',
        description: 'Other purchase',
      },
    ]);
    const other = (
      await db.query("SELECT id FROM transactions WHERE source_id='two'")
    ).rows[0]!;
    await new Receipts(db).attach('katya', receipt, String(other.id));
    current = (
      await db.query('SELECT * FROM transactions WHERE id=$1', [row.id])
    ).rows[0]!;
    assert.equal(current.kind, 'unresolved');
    assert.equal(current.category, null);
  } finally {
    await db.close();
  }
});
test('receipt evidence revisits an old automatic category but preserves human decisions and rules', async () => {
  const { db, row } = await setup('booked');
  try {
    await db.query(
      `UPDATE transactions SET kind='personal_expense',
       category_id=(SELECT id FROM category_tree WHERE slug='sport.gym') WHERE id=$1`,
      [row.id],
    );
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        return { status: 'proposed', id: randomUUID(), proposal: answer };
      },
    }));
    await worker.processOne();
    assert.equal(
      (
        await db.query('SELECT category FROM transactions WHERE id=$1', [
          row.id,
        ])
      ).rows[0]!.category,
      'Food / Groceries',
    );
    await db.query(
      "INSERT INTO audit_events(id,transaction_id,actor,event,after_value,reason) VALUES($1,$2,'rodion','classified','{}','Human choice')",
      [randomUUID(), row.id],
    );
    await db.query('UPDATE receipt_jobs SET updated_at=now()');
    assert.equal(await worker.processOne(), false);
  } finally {
    await db.close();
  }
});
test('changed receipt during classification is rejected; low confidence stays a proposal', async () => {
  const { db, row } = await setup();
  try {
    const before = (await loadReceiptEvidence(db, String(row.id)))!.key;
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        await db.query(
          "UPDATE receipt_jobs SET extraction=jsonb_set(extraction,'{items}', '[\"Unknown\"]'::jsonb)",
        );
        return { status: 'proposed', id: randomUUID(), proposal: answer };
      },
    }));
    await worker.processOne();
    assert.notEqual(
      (await loadReceiptEvidence(db, String(row.id)))!.key,
      before,
    );
    assert.equal(
      (await db.query('SELECT kind FROM transactions WHERE id=$1', [row.id]))
        .rows[0]!.kind,
      'unresolved',
    );
    const uncertain = new ReceiptCategorization(db, () => ({
      async propose() {
        return {
          status: 'proposed',
          id: randomUUID(),
          proposal: { ...answer, confidence: 0.6 },
        };
      },
    }));
    await uncertain.processOne();
    assert.equal(
      (await db.query('SELECT kind FROM transactions WHERE id=$1', [row.id]))
        .rows[0]!.kind,
      'unresolved',
    );
    assert.equal(await uncertain.processOne(), false);
  } finally {
    await db.close();
  }
});
test('confirmed rule and business policy block receipt automatic changes', async () => {
  const { db, row } = await setup();
  try {
    await db.query(
      "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','account','rodion','Business','business')",
    );
    let calls = 0;
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        calls++;
        return { status: 'proposed', id: randomUUID(), proposal: answer };
      },
    }));
    assert.equal(await worker.processOne(), false);
    assert.equal(calls, 0);
    await db.query("UPDATE own_accounts SET purpose='personal'");
    const nodes = await new Categories(db).listNodes();
    await new Categories(db).saveRule('rodion', {
      matcher: { field: 'description', value: 'Synthetic sports venue' },
      confirmed: true,
      kind: 'personal_expense',
      categoryId: nodes.find((n) => n.assignable)!.id,
      reason: 'Owner rule',
    });
    await worker.processOne();
    assert.equal(
      (await db.query('SELECT kind FROM transactions WHERE id=$1', [row.id]))
        .rows[0]!.kind,
      'unresolved',
    );
  } finally {
    await db.close();
  }
});

test('a concurrent reserved proposal cannot be marked checked before its result arrives', async () => {
  const { db, row } = await setup();
  try {
    const evidence = (await loadReceiptEvidence(db, String(row.id)))!;
    const id = randomUUID();
    await db.query(
      "INSERT INTO classifier_proposals(id,transaction_id,revision,owner,model,state,request_key) VALUES($1,$2,0,'rodion','synthetic','reserved',$3)",
      [id, row.id, evidence.key],
    );
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        return { status: 'already_requested' };
      },
    }));
    assert.equal(await worker.processOne(), false);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM audit_events WHERE event='receipt_categorization_checked'",
        )
      ).rows.length,
      0,
    );
    await db.query(
      "UPDATE classifier_proposals SET state='proposed',proposal=$2 WHERE id=$1",
      [id, JSON.stringify(answer)],
    );
    assert.equal(await worker.processOne(), true);
    assert.equal(
      (
        await db.query('SELECT category FROM transactions WHERE id=$1', [
          row.id,
        ])
      ).rows[0]!.category,
      'Food / Groceries',
    );
  } finally {
    await db.close();
  }
});

test('oversized receipt context is checked without crashing or repeated paid attempts', async () => {
  const { db } = await setup();
  try {
    let calls = 0;
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        calls++;
        throw new Error('classifier_input_limit');
      },
    }));
    assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), false);
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test('generic merchant triage cannot bypass inconclusive attached receipt evidence', async () => {
  const { db } = await setup('booked');
  try {
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          calls++;
          return { status: 'proposed', id: randomUUID(), proposal: answer };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), false);
    assert.equal(calls, 0);
  } finally {
    await db.close();
  }
});

test('a broad receipt category can use corroborating MCC without inventing exact items', async () => {
  const { db, row } = await setup();
  try {
    await db.query(
      'UPDATE transactions SET source_details=\'{"mcc":5812}\'::jsonb WHERE id=$1',
      [row.id],
    );
    const worker = new ReceiptCategorization(db, () => ({
      async propose() {
        return {
          status: 'proposed',
          id: randomUUID(),
          proposal: {
            ...answer,
            category: 'Food / Restaurants / Dining in',
            confidence: 0.84,
          },
        };
      },
    }));
    await worker.processOne();
    assert.equal(
      (
        await db.query('SELECT category FROM transactions WHERE id=$1', [
          row.id,
        ])
      ).rows[0]!.category,
      'Food / Restaurants / Dining in',
    );
    assert.equal(await worker.processOne(), false);
  } finally {
    await db.close();
  }
});
