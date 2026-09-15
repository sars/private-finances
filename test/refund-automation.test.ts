import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Refunds } from '../src/refunds.js';
import {
  REFUND_RULES_VERSION,
  RefundMatcher,
} from '../src/refund-automation.js';

const card = {
  source: 'monobank',
  accountId: 'card-uah',
  owner: 'rodion',
  currency: 'UAH',
};
const subscription = (over: Record<string, unknown>) => ({
  ...card,
  description: 'EPIDEMIC SOUND',
  ...over,
});

async function ledger(rows: Array<Record<string, unknown>>) {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(rows);
  return { db, repo, matcher: new RefundMatcher(db) };
}

test('a merchant reversal of the same original amount is linked without asking', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-08-03T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-13T10:00:00Z',
      amountMinor: '92885',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
      },
    }),
  ]);
  try {
    const now = new Date('2026-09-14T09:00:00Z');
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 1,
      asked: 0,
      unmatched: 0,
    });
    const rows = await repo.list('rodion');
    const charge = rows.find((r) => r.sourceId === 'charge')!;
    assert.equal(charge.refund!.netMinor, '-754');
    assert.equal(charge.refund!.reductions[0]!.origin, 'automatic');
    assert.equal(charge.refund!.reductions[0]!.rule, 'exact_original');
    // The credit keeps whatever it was; the link explains it and browsing hides
    // it, so nobody is asked to classify money that is already counted.
    assert.equal(
      rows.find((r) => r.sourceId === 'reversal')!.kind,
      'unresolved',
    );
    assert.equal(
      rows.find((r) => r.sourceId === 'reversal')!.refund!.role,
      'refund',
    );
    // A second pass has nothing left to do and does not link anything twice.
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 0,
      asked: 0,
      unmatched: 0,
    });
    assert.equal((await new Refunds(db).list('rodion')).length, 1);
    assert.deepEqual(await matcher.questions(), []);
  } finally {
    await db.close();
  }
});

test('an identical subscription on another account is never reduced by this refund', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'rodion-charge',
      bookedAt: '2026-08-03T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      accountId: 'katya-card',
      owner: 'katya',
      sourceId: 'katya-charge',
      bookedAt: '2026-08-03T10:00:00Z',
      amountMinor: '-46800',
      sourceDetails: {
        amount: -46800,
        operationAmount: -899,
        currencyCode: 978,
      },
    }),
    subscription({
      accountId: 'katya-card',
      owner: 'katya',
      sourceId: 'katya-reversal',
      bookedAt: '2026-09-13T10:00:00Z',
      amountMinor: '46000',
      sourceDetails: {
        amount: 46000,
        operationAmount: 899,
        currencyCode: 978,
      },
    }),
  ]);
  try {
    assert.equal(
      (await matcher.matchPending(25, new Date('2026-09-14T09:00:00Z'))).linked,
      1,
    );
    const rows = await repo.list();
    assert.equal(
      rows.find((r) => r.sourceId === 'rodion-charge')!.refund,
      undefined,
    );
    assert.equal(
      rows.find((r) => r.sourceId === 'katya-charge')!.refund!.fullyReduced,
      true,
    );
  } finally {
    await db.close();
  }
});

test('a question is recorded when nothing says which charge it was, and asked once', async () => {
  // Two rides the same whisker from the refund, hailed at the same moment.
  // Nothing in the data prefers one, so the matcher asks instead of guessing.
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'first',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-1001',
    }),
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'second',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-999',
    }),
    subscription({
      description: 'Скасування. BOLT RIGA',
      sourceId: 'reversal',
      bookedAt: '2026-09-02T10:00:00Z',
      amountMinor: '1000',
    }),
  ]);
  try {
    const now = new Date('2026-09-03T09:00:00Z');
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 0,
      asked: 1,
      unmatched: 0,
    });
    const [question] = await matcher.questions();
    assert.equal(question!.reason, 'differing_candidates');
    assert.equal(question!.candidateIds.length, 2);
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
    assert.equal((await repo.list('rodion')).length, 3);
    // The same question is not raised again.
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 0,
      asked: 0,
      unmatched: 0,
    });
    assert.equal((await matcher.questions()).length, 1);
  } finally {
    await db.close();
  }
});

test('identical rides are linked to the nearest preceding one, without a question', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'first',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-1000',
    }),
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'second',
      bookedAt: '2026-09-01T12:00:00Z',
      amountMinor: '-1000',
    }),
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'reversal',
      bookedAt: '2026-09-02T10:00:00Z',
      amountMinor: '1000',
    }),
  ]);
  try {
    assert.equal(
      (await matcher.matchPending(25, new Date('2026-09-03T09:00:00Z'))).linked,
      1,
    );
    const rows = await repo.list('rodion');
    // The cancellation belongs to the hold placed most recently before it.
    assert.equal(
      rows.find((r) => r.sourceId === 'second')!.refund!.fullyReduced,
      true,
    );
    assert.equal(rows.find((r) => r.sourceId === 'first')!.refund, undefined);
  } finally {
    await db.close();
  }
});

test('unexplained incoming money stays visible and is retried when its charge arrives later', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'BOLT RIGA',
      sourceId: 'reversal',
      bookedAt: '2026-09-02T10:00:00Z',
      amountMinor: '1000',
    }),
  ]);
  try {
    const first = new Date('2026-09-02T12:00:00Z');
    assert.deepEqual(await matcher.matchPending(25, first), {
      linked: 0,
      asked: 0,
      unmatched: 1,
    });
    const reversal = (await repo.list('rodion'))[0]!;
    assert.equal(reversal.kind, 'unresolved', 'it is never quietly netted');
    // The charge is imported after the refund, as a slow provider may deliver it.
    await repo.importBatch([
      subscription({
        description: 'BOLT RIGA',
        sourceId: 'charge',
        bookedAt: '2026-09-01T10:00:00Z',
        amountMinor: '-1000',
      }),
    ]);
    // Too soon: an unmatched decision is not recomputed on every pass.
    assert.equal((await matcher.matchPending(25, first)).linked, 0);
    const later = new Date('2026-09-02T20:00:00Z');
    assert.equal((await matcher.matchPending(25, later)).linked, 1);
  } finally {
    await db.close();
  }
});

test('money a person sent is left for the owner rather than guessed', async () => {
  const { db, matcher } = await ledger([
    subscription({
      description: 'Vasyl Petrenko',
      sourceId: 'transfer',
      bookedAt: '2026-09-02T10:00:00Z',
      amountMinor: '150000',
      sourceDetails: { counterName: 'Vasyl Petrenko', mcc: 4829 },
    }),
  ]);
  try {
    assert.deepEqual(
      await matcher.matchPending(25, new Date('2026-09-03T09:00:00Z')),
      { linked: 0, asked: 1, unmatched: 0 },
    );
    const [question] = await matcher.questions();
    assert.equal(question!.reason, 'from_person');
    assert.deepEqual(question!.candidateIds, []);
  } finally {
    await db.close();
  }
});

test('a credit an owner already explained or linked is left alone', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-08-03T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-13T10:00:00Z',
      amountMinor: '92885',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
      },
    }),
  ]);
  try {
    const rows = await repo.list('rodion');
    await repo.classify(
      rows.find((r) => r.sourceId === 'reversal')!.id,
      0,
      {
        kind: 'non_personal',
        category: null,
        reason: 'Owner explained this credit already',
      },
      'rodion',
    );
    assert.deepEqual(
      await matcher.matchPending(25, new Date('2026-09-14T09:00:00Z')),
      { linked: 0, asked: 0, unmatched: 0 },
    );
    assert.equal((await new Refunds(db).list('rodion')).length, 0);
  } finally {
    await db.close();
  }
});

test('a decision made by older rules is looked at again', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'Bolt',
      sourceId: 'earlier',
      bookedAt: '2026-08-27T08:00:00Z',
      amountMinor: '-10468',
      sourceDetails: {
        amount: -10468,
        operationAmount: -200,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Bolt',
      sourceId: 'later',
      bookedAt: '2026-08-28T08:00:00Z',
      amountMinor: '-10466',
      sourceDetails: {
        amount: -10466,
        operationAmount: -200,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'cancellation',
      bookedAt: '2026-08-29T08:00:00Z',
      amountMinor: '10466',
      sourceDetails: {
        amount: 10466,
        operationAmount: 200,
        currencyCode: 978,
      },
    }),
  ]);
  const now = new Date('2026-08-30T09:00:00Z');
  try {
    // An edition of the rules that could not tell the two rides apart left a
    // question behind. The question is reconsidered, not left standing.
    const cancellation = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'cancellation',
    )!;
    await db.query(
      `INSERT INTO refund_match_reviews(transaction_id,revision,outcome,reason,candidate_ids,rules_version)
       VALUES($1,$2,'asked','differing_candidates','[]'::jsonb,1)`,
      [cancellation.id, cancellation.revision],
    );
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 1,
      asked: 0,
      unmatched: 0,
    });
    const rows = await repo.list('rodion');
    // The charge whose hryvnia the cancellation repeats is the one reduced.
    assert.equal(
      rows.find((r) => r.sourceId === 'later')!.refund!.fullyReduced,
      true,
    );
    assert.equal(rows.find((r) => r.sourceId === 'earlier')!.refund, undefined);
    assert.equal(
      rows.find((r) => r.sourceId === 'later')!.refund!.reductions[0]!.rule,
      'exact_ledger_and_original',
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM refund_match_reviews WHERE rules_version=$1',
          [REFUND_RULES_VERSION],
        )
      ).rows[0]!.count,
      1,
    );
    // Decided under the current rules, it is not reconsidered again.
    assert.deepEqual(await matcher.matchPending(25, now), {
      linked: 0,
      asked: 0,
      unmatched: 0,
    });
  } finally {
    await db.close();
  }
});

test('a refund matched from a hold is recalculated when the bank settles it', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-12T22:42:00Z',
      amountMinor: '92885',
      status: 'pending',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
        hold: true,
      },
    }),
  ]);
  const now = new Date('2026-09-13T09:00:00Z');
  try {
    // Money the bank is still holding is matched now, not after it settles.
    assert.equal((await matcher.matchPending(25, now)).linked, 1);
    const held = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'charge',
    )!;
    assert.equal(held.refund!.provisional, true);
    assert.equal(held.refund!.netMinor, '-754');
    // The bank settles it two hryvnia lighter than the hold said.
    await repo.importBatch([
      subscription({
        sourceId: 'reversal',
        bookedAt: '2026-09-12T22:42:00Z',
        amountMinor: '92685',
        sourceDetails: {
          amount: 92685,
          operationAmount: 1799,
          currencyCode: 978,
          hold: false,
        },
      }),
    ]);
    assert.deepEqual(await matcher.reviewSettledLinks(), {
      recalculated: 1,
      removed: 0,
    });
    const settled = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'charge',
    )!;
    assert.equal(settled.refund!.reductions[0]!.reductionMinor, '92685');
    assert.equal(settled.refund!.netMinor, '-954');
    assert.equal(settled.refund!.provisional, false);
    assert.equal(settled.refund!.reductions[0]!.discrepancy, null);
    // Nothing further to do once both amounts are settled.
    assert.deepEqual(await matcher.reviewSettledLinks(), {
      recalculated: 0,
      removed: 0,
    });
  } finally {
    await db.close();
  }
});

test('a hold released without settling takes its link with it', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-12T22:42:00Z',
      amountMinor: '92885',
      status: 'pending',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
        hold: true,
      },
    }),
  ]);
  try {
    assert.equal(
      (await matcher.matchPending(25, new Date('2026-09-13T09:00:00Z'))).linked,
      1,
    );
    // The bank drops the hold: no money came back after all.
    await db.query(
      "UPDATE transactions SET amount_minor=0,status='booked' WHERE source_id='reversal'",
    );
    assert.deepEqual(await matcher.reviewSettledLinks(), {
      recalculated: 0,
      removed: 1,
    });
    const purchase = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'charge',
    )!;
    assert.equal(purchase.refund, undefined, 'the purchase costs what it cost');
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE event='refund_unlinked' AND actor='matcher'",
        )
      ).rows[0]!.count,
      1,
    );
  } finally {
    await db.close();
  }
});

/**
 * PGlite coerces an untyped boolean parameter that PostgreSQL rejects outright,
 * so the settlement pass ran green in every other test here and then failed on
 * the server. This exercises it against real PostgreSQL when one is configured.
 */
test(
  'the settlement pass runs on PostgreSQL, not only on PGlite',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { postgresDatabase } = await import('../src/database.js');
    const { randomUUID } = await import('node:crypto');
    const admin = postgresDatabase(process.env.TEST_DATABASE_URL!);
    const schema = 'refund_' + randomUUID().replaceAll('-', '');
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${schema}`);
      const db = postgresDatabase(url.toString());
      try {
        await migrate(db);
        const repo = new Repository(db);
        await repo.importBatch([
          subscription({
            sourceId: 'charge',
            bookedAt: '2026-09-01T10:00:00Z',
            amountMinor: '-93639',
            sourceDetails: {
              amount: -93639,
              operationAmount: -1799,
              currencyCode: 978,
            },
          }),
          subscription({
            sourceId: 'reversal',
            bookedAt: '2026-09-12T22:42:00Z',
            amountMinor: '92885',
            status: 'pending',
            sourceDetails: {
              amount: 92885,
              operationAmount: 1799,
              currencyCode: 978,
              hold: true,
            },
          }),
        ]);
        const matcher = new RefundMatcher(db);
        assert.equal(
          (await matcher.matchPending(25, new Date('2026-09-13T09:00:00Z')))
            .linked,
          1,
        );
        await repo.importBatch([
          subscription({
            sourceId: 'reversal',
            bookedAt: '2026-09-12T22:42:00Z',
            amountMinor: '92685',
            sourceDetails: {
              amount: 92685,
              operationAmount: 1799,
              currencyCode: 978,
              hold: false,
            },
          }),
        ]);
        assert.deepEqual(await matcher.reviewSettledLinks(), {
          recalculated: 1,
          removed: 0,
        });
        const purchase = (await repo.list('rodion')).find(
          (r) => r.sourceId === 'charge',
        )!;
        assert.equal(purchase.refund!.provisional, false);
        assert.equal(purchase.refund!.netMinor, '-954');
      } finally {
        await db.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  },
);

test('a link the service refuses is recorded, and the batch continues', async () => {
  const { db, repo, matcher } = await ledger([
    // A ride and its cancellation a whisker apart in euro, where the rate has
    // moved enough that the hryvnia coming back exceeds the hryvnia charged.
    subscription({
      description: 'Bolt',
      sourceId: 'ride',
      bookedAt: '2026-08-29T08:00:00Z',
      amountMinor: '-27149',
      sourceDetails: {
        amount: -27149,
        operationAmount: -520,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'cancellation',
      bookedAt: '2026-08-29T20:00:00Z',
      amountMinor: '27212',
      sourceDetails: { amount: 27212, operationAmount: 519, currencyCode: 978 },
    }),
    subscription({
      description: 'Vasyl Petrenko',
      sourceId: 'from-person',
      bookedAt: '2026-08-30T08:00:00Z',
      amountMinor: '150000',
      sourceDetails: { counterName: 'Vasyl Petrenko', mcc: 4829 },
    }),
  ]);
  try {
    // The reversal is linked even though it returns more hryvnia than the ride
    // cost, and the rest of the batch is decided in the same pass.
    assert.deepEqual(
      await matcher.matchPending(25, new Date('2026-08-31T09:00:00Z')),
      { linked: 1, asked: 1, unmatched: 0 },
    );
    const ride = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'ride',
    )!;
    assert.equal(ride.refund!.reductions[0]!.rule, 'nearest_amount');
    // More money came back than went out, so the purchase cost nothing; it is
    // never negative spending.
    assert.equal(ride.refund!.netMinor, '63');
    assert.equal(ride.refund!.fullyReduced, true);
  } finally {
    await db.close();
  }
});

test('a cancellation finds the ride even while the ride is still a hold', async () => {
  // The owner's Bolt case: both sides pending at first, and the charge itself is
  // the hold. Excluding holds from the candidate query once hid the very ride
  // the cancellation belonged to, and the matcher asked instead of linking.
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'Bolt',
      sourceId: 'ride',
      bookedAt: '2026-08-29T08:00:00Z',
      amountMinor: '-27149',
      status: 'pending',
      sourceDetails: {
        amount: -27149,
        operationAmount: -520,
        currencyCode: 978,
        hold: true,
      },
    }),
    subscription({
      description: 'Bolt',
      sourceId: 'other-ride',
      bookedAt: '2026-08-28T08:00:00Z',
      amountMinor: '-27736',
      sourceDetails: {
        amount: -27736,
        operationAmount: -530,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'cancellation',
      bookedAt: '2026-08-29T20:00:00Z',
      amountMinor: '27212',
      sourceDetails: { amount: 27212, operationAmount: 519, currencyCode: 978 },
    }),
  ]);
  try {
    assert.equal(
      (await matcher.matchPending(25, new Date('2026-08-31T09:00:00Z'))).linked,
      1,
    );
    const rows = await repo.list('rodion');
    const ride = rows.find((r) => r.sourceId === 'ride')!;
    assert.equal(ride.refund!.reductions[0]!.rule, 'nearest_amount');
    assert.equal(ride.refund!.provisional, true);
    assert.equal(
      rows.find((r) => r.sourceId === 'other-ride')!.refund,
      undefined,
    );
  } finally {
    await db.close();
  }
});

/**
 * The owner's Bolt receipts for 28 August: a ride hailed at 14:03 that ended at
 * 14:18 costing EUR 3.76, and a ride hailed at 14:15 and cancelled outright. Two
 * identical holds of EUR 10, a full refund and a partial one. Whichever order the
 * refunds are considered in, the cancelled ride must end at nothing and the real
 * one at what the receipt says.
 */
test('two identical holds end where the receipts say, in either order', async () => {
  for (const reversed of [false, true]) {
    const hold = (sourceId: string, minute: string) =>
      subscription({
        description: 'Bolt',
        sourceId,
        bookedAt: `2026-08-28T11:${minute}:00Z`,
        amountMinor: '-52340',
        sourceDetails: {
          amount: -52340,
          operationAmount: -1000,
          currencyCode: 978,
        },
      });
    const refunds = [
      subscription({
        description: 'Скасування. Bolt',
        sourceId: 'cancelled-in-full',
        bookedAt: '2026-08-28T11:16:00Z',
        amountMinor: '52340',
        sourceDetails: {
          amount: 52340,
          operationAmount: 1000,
          currencyCode: 978,
        },
      }),
      subscription({
        description: 'Скасування. Bolt',
        sourceId: 'change-from-the-ride',
        bookedAt: '2026-08-28T11:37:00Z',
        amountMinor: '32660',
        sourceDetails: {
          amount: 32660,
          operationAmount: 624,
          currencyCode: 978,
        },
      }),
    ];
    const { db, repo, matcher } = await ledger([
      hold('ride-that-ran', '03'),
      hold('ride-cancelled', '15'),
      ...(reversed ? refunds.reverse() : refunds),
    ]);
    try {
      assert.equal(
        (await matcher.matchPending(25, new Date('2026-08-29T09:00:00Z')))
          .linked,
        2,
      );
      const rows = await repo.list('rodion');
      const ran = rows.find((r) => r.sourceId === 'ride-that-ran')!;
      const cancelled = rows.find((r) => r.sourceId === 'ride-cancelled')!;
      // EUR 3.76 of the hold was kept, which is what the receipt says the ride
      // cost; the cancelled one kept nothing.
      assert.equal(ran.refund!.netMinor, '-19680');
      assert.equal(cancelled.refund!.netMinor, '0');
    } finally {
      await db.close();
    }
  }
});

test('links the matcher made under older rules are re-decided, human ones are not', async () => {
  // The owner's 28 August pair as the old rules left it: the full refund on the
  // ride that ran, the partial one on the ride that was cancelled — each row
  // telling the other's story.
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'Bolt',
      sourceId: 'ride-that-ran',
      bookedAt: '2026-08-28T11:03:00Z',
      amountMinor: '-52340',
      sourceDetails: {
        amount: -52340,
        operationAmount: -1000,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Bolt',
      sourceId: 'ride-cancelled',
      bookedAt: '2026-08-28T11:15:00Z',
      amountMinor: '-52340',
      sourceDetails: {
        amount: -52340,
        operationAmount: -1000,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'full-refund',
      bookedAt: '2026-08-28T11:16:00Z',
      amountMinor: '52340',
      sourceDetails: {
        amount: 52340,
        operationAmount: 1000,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'change-from-the-ride',
      bookedAt: '2026-08-28T11:37:00Z',
      amountMinor: '32660',
      sourceDetails: {
        amount: 32660,
        operationAmount: 624,
        currencyCode: 978,
      },
    }),
  ]);
  const refunds = new Refunds(db);
  const now = new Date('2026-08-29T09:00:00Z');
  const id = async (sourceId: string) =>
    (await repo.list('rodion')).find((r) => r.sourceId === sourceId)!;
  try {
    // Recreate what an older edition wrote, version and all.
    await refunds.link({
      debitId: (await id('ride-that-ran')).id,
      creditId: (await id('full-refund')).id,
      expectedDebitRevision: 0,
      expectedCreditRevision: 0,
      owner: 'rodion',
      origin: 'automatic',
      rule: 'indistinguishable_oldest',
      rulesVersion: 1,
      reason: 'Automatic refund match (older edition)',
    });
    await refunds.link({
      debitId: (await id('ride-cancelled')).id,
      creditId: (await id('change-from-the-ride')).id,
      expectedDebitRevision: 0,
      expectedCreditRevision: 0,
      owner: 'rodion',
      origin: 'automatic',
      rule: 'single_partial',
      rulesVersion: 1,
      reason: 'Automatic refund match (older edition)',
    });
    assert.equal(await matcher.reassignOwnLinks(), 2);
    await matcher.matchPending(25, now);
    // Each ride now carries its own story: the cancelled one cost nothing and
    // the one that ran cost what the receipt says.
    assert.equal((await id('ride-cancelled')).refund!.netMinor, '0');
    assert.equal((await id('ride-that-ran')).refund!.netMinor, '-19680');
    // Settled under the current edition, nothing is released a second time.
    assert.equal(await matcher.reassignOwnLinks(), 0);
  } finally {
    await db.close();
  }
});

test('a categorised purchase does not protect a link the matcher guessed', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      description: 'Bolt',
      sourceId: 'ride',
      bookedAt: '2026-08-28T11:03:00Z',
      amountMinor: '-52340',
      sourceDetails: {
        amount: -52340,
        operationAmount: -1000,
        currencyCode: 978,
      },
    }),
    subscription({
      description: 'Скасування. Bolt',
      sourceId: 'refund',
      bookedAt: '2026-08-28T11:16:00Z',
      amountMinor: '52340',
      sourceDetails: {
        amount: 52340,
        operationAmount: 1000,
        currencyCode: 978,
      },
    }),
  ]);
  try {
    const rows = await repo.list('rodion');
    const ride = rows.find((r) => r.sourceId === 'ride')!;
    // Every purchase gets a category. That must not freeze the pairing.
    await repo.classify(
      ride.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Transport / Public transport',
        reason: 'Owner categorised the ride',
      },
      'rodion',
    );
    await new Refunds(db).link({
      debitId: ride.id,
      creditId: rows.find((r) => r.sourceId === 'refund')!.id,
      expectedDebitRevision: 1,
      expectedCreditRevision: 0,
      owner: 'rodion',
      origin: 'automatic',
      rule: 'exact_original',
      rulesVersion: 1,
      reason: 'Automatic refund match (older edition)',
    });
    assert.equal(await matcher.reassignOwnLinks(), 1);
  } finally {
    await db.close();
  }
});

test('a link a person confirmed is never re-decided by the matcher', async () => {
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-12T10:00:00Z',
      amountMinor: '92885',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
      },
    }),
  ]);
  try {
    const rows = await repo.list('rodion');
    await new Refunds(db).link({
      debitId: rows.find((r) => r.sourceId === 'charge')!.id,
      creditId: rows.find((r) => r.sourceId === 'reversal')!.id,
      expectedDebitRevision: 0,
      expectedCreditRevision: 0,
      owner: 'rodion',
      reason: 'Owner confirmed this refund by hand',
    });
    assert.equal(await matcher.reassignOwnLinks(), 0);
    assert.equal(
      (await new Refunds(db).list('rodion'))[0]!.state,
      'active',
      'a confirmed link is untouched',
    );
  } finally {
    await db.close();
  }
});

test('a released link is replaced, not lost', async () => {
  // Releasing a link and leaving its decision behind lost eighty links in
  // production: the credit had no link, the stored decision still said it had
  // one, and nothing ever looked at it again.
  const { db, repo, matcher } = await ledger([
    subscription({
      sourceId: 'charge',
      bookedAt: '2026-09-01T10:00:00Z',
      amountMinor: '-93639',
      sourceDetails: {
        amount: -93639,
        operationAmount: -1799,
        currencyCode: 978,
      },
    }),
    subscription({
      sourceId: 'reversal',
      bookedAt: '2026-09-12T10:00:00Z',
      amountMinor: '92885',
      sourceDetails: {
        amount: 92885,
        operationAmount: 1799,
        currencyCode: 978,
      },
    }),
  ]);
  const now = new Date('2026-09-13T09:00:00Z');
  try {
    assert.equal((await matcher.matchPending(25, now)).linked, 1);
    // An older edition's link, released on the next pass.
    await db.query(
      "UPDATE refund_links SET evidence=evidence-'rulesVersion' WHERE state='active'",
    );
    assert.equal(await matcher.reassignOwnLinks(), 1);
    assert.equal((await matcher.matchPending(25, now)).linked, 1);
    const purchase = (await repo.list('rodion')).find(
      (r) => r.sourceId === 'charge',
    )!;
    assert.equal(purchase.refund!.netMinor, '-754');
    // And a decision left claiming a link that no longer exists heals itself.
    await db.query(
      "UPDATE refund_links SET state='unlinked' WHERE state='active'",
    );
    assert.equal((await matcher.matchPending(25, now)).linked, 1);
    assert.equal(
      (await repo.list('rodion')).find((r) => r.sourceId === 'charge')!.refund!
        .netMinor,
      '-754',
    );
  } finally {
    await db.close();
  }
});
