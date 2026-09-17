import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Conflict } from '../src/errors.js';
import {
  Refunds,
  attachRefunds,
  initializeRefunds,
  restoreRefundedCredits,
  restoreRefundedPurchases,
} from '../src/refunds.js';

const debitInput = {
  source: 'synthetic',
  accountId: 'a',
  sourceId: 'debit',
  owner: 'rodion',
  bookedAt: '2026-07-01T12:00:00Z',
  currency: 'EUR',
  amountMinor: '-900719925474099312345',
  description: 'Synthetic purchase',
};
const creditInput = {
  ...debitInput,
  sourceId: 'credit',
  bookedAt: '2026-07-03T12:00:00Z',
  amountMinor: '900719925474099312345',
  description: 'Synthetic refund',
};
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeRefunds);
  const repo = new Repository(db);
  await repo.importBatch([debitInput, creditInput]);
  const rows = await repo.list();
  return {
    db,
    repo,
    refunds: new Refunds(db),
    debit: rows.find((r) => r.sourceId === 'debit')!,
    credit: rows.find((r) => r.sourceId === 'credit')!,
  };
}
const link = (
  refunds: Refunds,
  debitId: string,
  creditId: string,
  debitRevision = 0,
  creditRevision = 0,
  reason = 'Owner confirms this credit returned the purchase',
  extra: { origin?: 'manual' | 'automatic'; rule?: string } = {},
) =>
  refunds.link({
    debitId,
    creditId,
    expectedDebitRevision: debitRevision,
    expectedCreditRevision: creditRevision,
    owner: 'rodion',
    reason,
    ...extra,
  });

test('a refund reduces the purchase, leaves both records alone, and can be undone', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await repo.classify(
      debit.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Owner initial label',
      },
      'rodion',
    );
    await repo.classify(
      credit.id,
      0,
      {
        kind: 'investment',
        category: null,
        reason: 'Owner earlier interpretation',
      },
      'rodion',
    );
    const saved = await link(refunds, debit.id, credit.id, 1, 1);
    assert.equal(saved.state, 'active');
    assert.equal(saved.revision, 1);
    assert.equal(saved.reductionMinor, creditInput.amountMinor);
    assert.equal(saved.currency, 'EUR');
    assert.equal(saved.origin, 'manual');
    assert.equal(saved.evidence.debitAmountMinor, debitInput.amountMinor);
    assert.equal((await refunds.list('katya')).length, 0);
    const rows = await repo.list();
    const purchase = rows.find((r) => r.id === debit.id)!;
    const returned = rows.find((r) => r.id === credit.id)!;
    // The purchase keeps the amount the bank recorded and its own classification.
    assert.equal(purchase.kind, 'personal_expense');
    assert.equal(purchase.category, 'Food / Groceries');
    assert.equal(purchase.revision, 1);
    assert.equal(purchase.amountMinor, debitInput.amountMinor);
    assert.equal(purchase.refund!.role, 'reduced');
    assert.equal(purchase.refund!.reducedMinor, creditInput.amountMinor);
    assert.equal(purchase.refund!.netMinor, '0');
    assert.equal(purchase.refund!.currency, 'EUR');
    assert.equal(purchase.refund!.approximate, false);
    assert.equal(purchase.refund!.fullyReduced, true);
    assert.equal(purchase.refund!.reductions[0]!.discrepancy, null);
    assert.equal(
      purchase.refund!.reductions[0]!.convertedMinor,
      creditInput.amountMinor,
    );
    // The credit is not classified: it is counted through the purchase and kept
    // out of browsing, so the same money is never judged twice.
    assert.equal(returned.kind, 'investment');
    assert.equal(returned.revision, 1);
    assert.equal(returned.refund!.role, 'refund');
    const linkedAudits = (
      await db.query("SELECT * FROM audit_events WHERE event='refund_linked'")
    ).rows;
    assert.equal(linkedAudits.length, 2);
    assert.ok(
      linkedAudits.every(
        (a) =>
          a.actor === 'rodion' &&
          (a.after_value as Record<string, unknown>).refundLinkId === saved.id,
      ),
    );
    await assert.rejects(
      refunds.unlink(saved.id, 0, 'rodion', 'Stale view'),
      /stale_refund_revision/,
    );
    // Either member may undo the household's link, so the link's owner is
    // read from the link itself; only a link that does not exist is refused.
    await assert.rejects(
      refunds.unlink(
        '00000000-0000-4000-8000-000000000000',
        1,
        'katya',
        'No such link',
      ),
      /not_found/,
    );
    const unlinked = await refunds.unlink(
      saved.id,
      1,
      'rodion',
      'Owner corrects pairing',
    );
    assert.equal(unlinked.state, 'unlinked');
    assert.equal(unlinked.revision, 2);
    assert.ok(unlinked.unlinkedAt);
    const after = await repo.list();
    assert.equal(after.find((r) => r.id === debit.id)!.refund, undefined);
    const unlinkedCredit = after.find((r) => r.id === credit.id)!;
    assert.equal(unlinkedCredit.kind, 'investment');
    assert.equal(
      unlinkedCredit.revision,
      1,
      'nothing was written to the credit',
    );
    assert.equal(unlinkedCredit.refund, undefined);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE event='refund_unlinked'",
        )
      ).rows.length,
      2,
    );
    assert.equal(
      (await refunds.list('rodion')).length,
      1,
      'unlink retains pair history',
    );
    const relink = await link(refunds, debit.id, credit.id, 1, 1);
    assert.notEqual(relink.id, saved.id);
  } finally {
    await db.close();
  }
});

test('pair validation rejects stale revisions, foreign owners and mismatched pairs', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await assert.rejects(link(refunds, debit.id, credit.id, 1, 0), Conflict);
    await assert.rejects(
      refunds.link({
        debitId: debit.id,
        creditId: credit.id,
        expectedDebitRevision: 0,
        expectedCreditRevision: 0,
        owner: 'katya',
        reason: 'Foreign',
      }),
      /not_found/,
    );
    await assert.rejects(
      link(refunds, debit.id, debit.id),
      /invalid_refund_pair/,
    );
    await assert.rejects(
      link(refunds, credit.id, debit.id),
      /invalid_refund_pair/,
    );
    await repo.importBatch([
      { ...creditInput, owner: 'katya', sourceId: 'other-owner' },
    ]);
    const otherOwner = (await repo.list()).find(
      (r) => r.sourceId === 'other-owner',
    )!;
    await assert.rejects(link(refunds, debit.id, otherOwner.id), /not_found/);
    // Money the bank is still holding is linked provisionally rather than
    // refused, and the link says so.
    await repo.importBatch([
      { ...creditInput, status: 'pending', sourceId: 'held' },
    ]);
    const held = (await repo.list()).find((r) => r.sourceId === 'held')!;
    const provisional = await link(refunds, debit.id, held.id);
    assert.equal(provisional.evidence.provisional, true);
    await refunds.unlink(provisional.id, 1, 'rodion', 'Undo for the next case');
    // A person may confirm a credit on another account; the matcher may not.
    await repo.importBatch([
      { ...creditInput, accountId: 'other', sourceId: 'other-account' },
    ]);
    const otherAccount = (await repo.list()).find(
      (r) => r.sourceId === 'other-account',
    )!;
    await assert.rejects(
      link(
        refunds,
        debit.id,
        otherAccount.id,
        0,
        0,
        'Automatic across accounts',
        {
          origin: 'automatic',
        },
      ),
      /invalid_refund_pair/,
    );
    // A credit in another currency needs a rate for the day it arrived, and
    // nothing is guessed when there is none.
    await repo.importBatch([
      { ...creditInput, currency: 'USD', sourceId: 'other-currency' },
    ]);
    const otherCurrency = (await repo.list()).find(
      (r) => r.sourceId === 'other-currency',
    )!;
    await assert.rejects(
      link(refunds, debit.id, otherCurrency.id),
      /refund_conversion_unavailable/,
    );
    const crossAccount = await link(
      refunds,
      debit.id,
      otherAccount.id,
      0,
      0,
      'Owner confirms a refund that arrived on another account',
    );
    assert.equal(crossAccount.state, 'active');
    assert.equal(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE event='refund_linked' AND after_value->>'refundLinkId'=$1",
          [crossAccount.id],
        )
      ).rows.length,
      2,
    );
  } finally {
    await db.close();
  }
});

test('reductions accumulate on one purchase and never exceed what it cost', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const refunds = new Refunds(db);
  try {
    await repo.importBatch([
      { ...debitInput, amountMinor: '-1000', description: 'BOLT RIGA' },
      {
        ...creditInput,
        sourceId: 'first',
        amountMinor: '600',
        description: 'BOLT RIGA',
      },
      {
        ...creditInput,
        sourceId: 'second',
        amountMinor: '400',
        description: 'BOLT RIGA',
      },
      {
        ...creditInput,
        sourceId: 'third',
        amountMinor: '100',
        description: 'BOLT RIGA',
      },
    ]);
    const rows = await repo.list();
    const purchase = rows.find((r) => r.sourceId === 'debit')!;
    const id = (sourceId: string) =>
      rows.find((r) => r.sourceId === sourceId)!.id;
    await link(refunds, purchase.id, id('first'));
    await link(refunds, purchase.id, id('second'));
    const reduced = (await repo.list()).find((r) => r.id === purchase.id)!;
    assert.equal(reduced.refund!.reducedMinor, '1000');
    assert.equal(reduced.refund!.netMinor, '0');
    assert.equal(reduced.refund!.reductions.length, 2);
    await assert.rejects(
      link(refunds, purchase.id, id('third')),
      /refund_exceeds_purchase/,
    );
  } finally {
    await db.close();
  }
});

test('a refund larger than its purchase is accepted only when the merchant returned the same original amount', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const refunds = new Refunds(db);
  try {
    const monobank = {
      source: 'monobank',
      accountId: 'card-uah',
      owner: 'rodion',
      currency: 'UAH',
      description: 'EPIDEMIC SOUND',
    };
    await repo.importBatch([
      {
        ...monobank,
        sourceId: 'charge',
        bookedAt: '2026-08-03T10:00:00Z',
        amountMinor: '-93639',
        sourceDetails: {
          amount: -93639,
          operationAmount: -1799,
          currencyCode: 978,
        },
      },
      {
        ...monobank,
        sourceId: 'reversal',
        bookedAt: '2026-09-13T10:00:00Z',
        amountMinor: '94000',
        sourceDetails: {
          amount: 94000,
          operationAmount: 1799,
          currencyCode: 978,
        },
      },
      {
        ...monobank,
        sourceId: 'far-too-large',
        bookedAt: '2026-09-13T10:00:00Z',
        amountMinor: '120000',
        sourceDetails: {},
      },
    ]);
    const rows = await repo.list();
    const id = (sourceId: string) =>
      rows.find((r) => r.sourceId === sourceId)!.id;
    // A whisker over the purchase is allowed, because that is what a rate move
    // or a merchant's rounding leaves behind.
    await assert.rejects(
      link(refunds, id('charge'), id('far-too-large')),
      /refund_exceeds_purchase/,
    );
    const saved = await link(refunds, id('charge'), id('reversal'));
    // The merchant returned exactly what it charged, so there is no surplus:
    // the extra hryvnia is the rate moving between the two days.
    assert.equal(saved.evidence.fxSurplus, undefined);
    assert.equal(saved.evidence.originalCurrency, 'EUR');
    const purchase = (await repo.list()).find((r) => r.id === id('charge'))!;
    // The rate moved; spending counts nothing rather than negative spending.
    assert.equal(purchase.refund!.netMinor, '361');
    assert.equal(purchase.refund!.fullyReduced, true);
    // An excess the rules allowed is not a disagreement, so the credit is not
    // held back in the list as though something needed checking.
    assert.equal(purchase.refund!.reductions[0]!.discrepancy, null);
  } finally {
    await db.close();
  }
});

test('a credit explains at most one purchase even under concurrent confirmation', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await repo.importBatch([{ ...debitInput, sourceId: 'other-debit' }]);
    const other = (await repo.list()).find(
      (r) => r.sourceId === 'other-debit',
    )!;
    const results = await Promise.allSettled([
      link(refunds, debit.id, credit.id, 0, 0, 'First candidate'),
      link(refunds, other.id, credit.id, 0, 0, 'Other candidate'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM refund_links WHERE state='active'",
        )
      ).rows[0]!.count,
      1,
    );
    const saved = (await refunds.list('rodion')).find(
      (item) => item.state === 'active',
    )!;
    await assert.rejects(
      link(refunds, saved.debitId, saved.creditId, 0, 0, 'Already linked'),
      /refund_already_linked/,
    );
  } finally {
    await db.close();
  }
});

test('a later decision on the credit does not block undoing the link', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    const saved = await link(refunds, debit.id, credit.id);
    await repo.classify(
      credit.id,
      0,
      { kind: 'non_personal', category: null, reason: 'New owner decision' },
      'rodion',
    );
    // The link wrote nothing to the credit, so an undo has nothing to overwrite
    // and the owner's own decision simply stands.
    await refunds.unlink(saved.id, 1, 'rodion', 'Undo');
    assert.equal(
      (await repo.list()).find((r) => r.id === credit.id)!.kind,
      'non_personal',
    );
    assert.equal((await refunds.list('rodion'))[0]!.state, 'unlinked');
    assert.equal(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE event='refund_unlinked'",
        )
      ).rows.length,
      2,
    );
  } finally {
    await db.close();
  }
});

test('a changed amount is surfaced beside the link instead of undoing it', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await link(refunds, debit.id, credit.id);
    await repo.importBatch([
      { ...debitInput, amountMinor: '-900719925474099312000' },
    ]);
    const purchase = (await repo.list()).find((r) => r.id === debit.id)!;
    // The correction itself is the thing to see; that the old reduction is now
    // larger than the corrected purchase is the same event said twice.
    assert.equal(
      purchase.refund!.reductions[0]!.discrepancy,
      'purchase_amount_changed',
    );
    assert.equal((await refunds.list('rodion'))[0]!.state, 'active');
  } finally {
    await db.close();
  }
});

test('candidate purchases come from the same account, inside the window, and exclude linked credits', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const refunds = new Refunds(db);
  try {
    const start = Date.parse('2026-09-13T10:00:00Z');
    const purchase = {
      source: 'synthetic',
      accountId: 'a',
      owner: 'rodion',
      currency: 'EUR',
      amountMinor: '-1000',
      description: 'BOLT RIGA',
    };
    await repo.importBatch([
      {
        ...purchase,
        sourceId: 'inside',
        bookedAt: new Date(start - 30 * 86400000).toISOString(),
      },
      {
        ...purchase,
        sourceId: 'boundary',
        bookedAt: new Date(start - 120 * 86400000).toISOString(),
      },
      {
        ...purchase,
        sourceId: 'too-old',
        bookedAt: new Date(start - 120 * 86400000 - 1000).toISOString(),
      },
      {
        ...purchase,
        sourceId: 'other-account',
        accountId: 'b',
        bookedAt: new Date(start - 86400000).toISOString(),
      },
      {
        ...purchase,
        sourceId: 'other-merchant',
        description: 'RIMI MR MARIJAS',
        bookedAt: new Date(start - 86400000).toISOString(),
      },
      {
        ...purchase,
        sourceId: 'refund',
        amountMinor: '1000',
        bookedAt: new Date(start).toISOString(),
      },
    ]);
    const rows = await repo.list();
    const id = (sourceId: string) =>
      rows.find((r) => r.sourceId === sourceId)!.id;
    const candidates = await refunds.candidates('rodion', id('refund'));
    assert.deepEqual(
      candidates.map((c) => c.id),
      [id('boundary'), id('inside')],
    );
    assert.equal(candidates[0]!.exactOriginal, true);
    assert.equal(candidates[0]!.remainingMinor, '1000');
    assert.ok(rows.every((r) => r.kind === 'unresolved' && r.revision === 0));
    await assert.rejects(
      refunds.candidates('katya', id('refund')),
      /not_found/,
    );
    // A purchase is never a candidate for the credit that already explains it.
    await link(refunds, id('inside'), id('refund'));
    const remaining = await refunds.candidates('rodion', id('refund'));
    assert.deepEqual(
      remaining.map((c) => c.id),
      [id('boundary')],
    );
  } finally {
    await db.close();
  }
});

test('an audit failure rolls back the link and leaves both transactions untouched', async () => {
  const { db, repo, debit, credit } = await setup();
  try {
    const refunds = new Refunds({
      ...db,
      transaction: (action) =>
        db.transaction((tx) =>
          action({
            query: (sql, params) => {
              if (sql.includes('INSERT INTO audit_events'))
                throw new Error('synthetic_audit_failure');
              return tx.query(sql, params);
            },
          }),
        ),
    });
    await assert.rejects(
      link(refunds, debit.id, credit.id),
      /synthetic_audit_failure/,
    );
    assert.equal((await db.query('SELECT * FROM refund_links')).rows.length, 0);
    assert.ok(
      (await repo.list()).every(
        (r) => r.kind === 'unresolved' && r.revision === 0,
      ),
    );
  } finally {
    await db.close();
  }
});

test('a source correction preserves a confirmed refund even when the purchase was auto-classified', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    const { TransactionTriage } = await import('../src/transaction-triage.js');
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          return {
            status: 'proposed',
            id: 'synthetic-automatic-proposal',
            proposal: {
              kind: 'personal_expense',
              category: 'Food / Groceries',
              confidence: 0.99,
              explanation: 'Synthetic purchase context',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    await triage.processOne();
    assert.equal(
      (await repo.list()).find((row) => row.id === debit.id)!.kind,
      'personal_expense',
    );
    await link(refunds, debit.id, credit.id, 1, 0);
    await repo.importBatch([
      { ...debitInput, description: 'Source-corrected synthetic purchase' },
      { ...creditInput, description: 'Source-corrected synthetic refund' },
    ]);
    const rows = await repo.list();
    const purchase = rows.find((row) => row.id === debit.id)!;
    const returned = rows.find((row) => row.id === credit.id)!;
    // The refund is a human decision, so the import does not undo the category.
    assert.equal(purchase.kind, 'personal_expense');
    assert.equal(purchase.category, 'Food / Groceries');
    assert.equal(returned.kind, 'unresolved');
    assert.equal(returned.refund!.role, 'refund');
    assert.equal((await refunds.list('rodion'))[0]!.state, 'active');
  } finally {
    await db.close();
  }
});

test('links made under the previous model are restored to the purchase they rewrote', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await repo.classify(
      debit.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Owner initial label',
      },
      'rodion',
    );
    const saved = await link(refunds, debit.id, credit.id, 1, 0);
    // Recreate exactly what the previous model left behind.
    await db.query(
      "UPDATE transactions SET kind='non_personal',category_id=NULL,revision=revision+1 WHERE id=$1",
      [debit.id],
    );
    await db.query(
      'UPDATE refund_links SET applied_debit_revision=2 WHERE id=$1',
      [saved.id],
    );
    const restored = await db.transaction(restoreRefundedPurchases);
    assert.equal(restored, 1);
    const purchase = (await repo.list()).find((r) => r.id === debit.id)!;
    assert.equal(purchase.kind, 'personal_expense');
    assert.equal(purchase.category, 'Food / Groceries');
    assert.equal(purchase.refund!.fullyReduced, true);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event='refund_purchase_restored'",
        )
      ).rows[0]!.count,
      1,
    );
    // Idempotent: a second migration pass changes nothing.
    assert.equal(await db.transaction(restoreRefundedPurchases), 0);
  } finally {
    await db.close();
  }
});

test('attachRefunds leaves unrelated rows untouched and needs no query for none', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    await link(refunds, debit.id, credit.id);
    const rows = await repo.list();
    const attached = await attachRefunds(
      db,
      rows.map((row) => ({ id: row.id, amountMinor: row.amountMinor })),
    );
    assert.equal(attached.filter((row) => row.refund).length, 2);
    assert.deepEqual(await attachRefunds(db, []), []);
  } finally {
    await db.close();
  }
});

test('credits the earlier model classified are left unclassified again', async () => {
  const { db, repo, refunds, debit, credit } = await setup();
  try {
    const saved = await link(refunds, debit.id, credit.id);
    // Recreate what linking used to write to the credit.
    await db.query(
      "UPDATE transactions SET kind='non_personal',category_id=NULL,revision=revision+1 WHERE id=$1",
      [credit.id],
    );
    await db.query(
      'UPDATE refund_links SET applied_credit_revision=1 WHERE id=$1',
      [saved.id],
    );
    assert.equal(await db.transaction(restoreRefundedCredits), 1);
    const returned = (await repo.list()).find((r) => r.id === credit.id)!;
    assert.equal(returned.kind, 'unresolved');
    assert.equal(returned.refund!.role, 'refund');
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event='refund_credit_restored'",
        )
      ).rows[0]!.count,
      1,
    );
    // Idempotent: a second pass changes nothing, and the link still stands.
    assert.equal(await db.transaction(restoreRefundedCredits), 0);
    assert.equal((await refunds.list('rodion'))[0]!.state, 'active');
  } finally {
    await db.close();
  }
});

test('a refund in another currency is converted into the purchase currency', async () => {
  const { db, repo, refunds, debit } = await setup();
  try {
    const { FxRates } = await import('../src/fx-rates.js');
    await new FxRates(db).insert({
      source: 'synthetic-market',
      base: 'USD',
      target: 'EUR',
      rate: '0.5',
      asOf: '2026-07-03',
      retrievedAt: '2026-07-04T00:00:00Z',
      version: 1,
      provenance: 'Synthetic daily rate',
    });
    await repo.importBatch([
      {
        ...creditInput,
        sourceId: 'usd-refund',
        accountId: 'usd',
        currency: 'USD',
        amountMinor: '200',
      },
    ]);
    const usd = (await repo.list()).find((r) => r.sourceId === 'usd-refund')!;
    const saved = await link(
      refunds,
      debit.id,
      usd.id,
      0,
      0,
      'Owner confirms a repayment that arrived in another currency',
    );
    assert.equal(saved.currency, 'USD');
    assert.equal(saved.reductionMinor, '200');
    const purchase = (await repo.list()).find((r) => r.id === debit.id)!;
    // 2.00 USD came back; at half a euro to the dollar that is 1.00 EUR.
    assert.equal(purchase.refund!.reductions[0]!.convertedMinor, '100');
    assert.equal(purchase.refund!.approximate, true);
    assert.equal(purchase.refund!.reducedMinor, '100');
    assert.equal(
      purchase.refund!.netMinor,
      (BigInt(debitInput.amountMinor) + 100n).toString(),
    );
    assert.equal(purchase.refund!.currency, 'EUR');
  } finally {
    await db.close();
  }
});
