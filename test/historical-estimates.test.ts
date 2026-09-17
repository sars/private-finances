import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateHistoricalSpending,
  historicalEstimateWindow,
  type HistoricalEstimateInput,
} from '../src/historical-estimates.js';
const options = { now: new Date('2026-09-12T09:00:00Z') };
function example(): HistoricalEstimateInput {
  return {
    transaction: {
      id: 'synthetic',
      source: 'monobank',
      sourceId: 'synthetic',
      accountId: 'synthetic',
      owner: 'rodion',
      bookedAt: '2026-07-12T10:00:00Z',
      currency: 'UAH',
      amountMinor: '-15000',
      description: 'Synthetic shop',
      status: 'booked',
      kind: 'unresolved',
      category: null,
      categoryId: null,
      provisional: false,
      classificationSource: 'none' as const,
      revision: 3,
    },
    hasHumanDecision: false,
    refundLinked: false,
    categoryPaths: [
      'Food / Groceries',
      'Food / Restaurants / Dining in',
      'Pets',
    ],
    sourceDetails: { mcc: 5411 },
    uah: { amountMinor: '-15000', provenance: null },
  };
}
test('historical MCC estimate is a separate deterministic projection and leaves ledger unchanged', () => {
  const input = example();
  const before = structuredClone(input);
  const result = estimateHistoricalSpending(input, options);
  assert.equal(result.status, 'estimated');
  assert.equal(result.method, 'mcc');
  assert.equal(result.category, 'Food / Groceries');
  assert.equal(result.confidence, 0.6);
  assert.deepEqual(input, before);
  assert.deepEqual(result, estimateHistoricalSpending(input, options));
});
test('calendar window uses Riga boundaries and keeps prior month for manual review', () => {
  assert.deepEqual(historicalEstimateWindow(options), {
    startDate: '2026-01-01',
    cutoffDate: '2026-08-01',
  });
  const input = example();
  input.transaction.bookedAt = '2026-07-31T21:00:00Z';
  assert.equal(
    estimateHistoricalSpending(input, options).status,
    'out_of_scope',
  );
  input.transaction.bookedAt = '2026-07-31T20:59:59Z';
  assert.equal(estimateHistoricalSpending(input, options).status, 'estimated');
  assert.equal(
    estimateHistoricalSpending(input, { ...options, cutoffDate: '2026-07-01' })
      .status,
    'out_of_scope',
  );
});
test('manual decisions, refund links, classified, pending, incoming, excluded and 2025 never get estimates', () => {
  const edits: ((x: HistoricalEstimateInput) => void)[] = [
    (x) => {
      x.hasHumanDecision = true;
    },
    (x) => {
      x.refundLinked = true;
    },
    (x) => {
      x.transaction.kind = 'personal_expense';
    },
    (x) => {
      x.transaction.status = 'pending';
    },
    (x) => {
      x.transaction.amountMinor = '15000';
    },
    (x) => {
      x.transaction.spendingPolicy = {
        accountLabel: null,
        accountPurpose: 'business',
        accountRevision: 1,
        excluded: true,
        visibility: 'excluded',
        suggestedKind: 'non_personal',
        reason: 'business_account',
      };
    },
    (x) => {
      x.transaction.bookedAt = '2025-12-25T12:00:00Z';
    },
  ];
  for (const edit of edits) {
    const input = example();
    edit(input);
    assert.equal(
      estimateHistoricalSpending(input, options).status,
      'out_of_scope',
    );
  }
});
test('large unknown payments and transfer MCCs remain review even with confident AI', () => {
  for (const mcc of [4829, 6012, 6051, 6211, 6536]) {
    const input = example();
    input.sourceDetails = { mcc };
    input.cachedProposal = {
      id: 'proposal',
      revision: 3,
      state: 'ready',
      decision: {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        confidence: 0.99,
        explanation: 'guess',
      },
    };
    assert.equal(
      estimateHistoricalSpending(input, options).status,
      'needs_review',
    );
  }
  // The 3,000 UAH line was retired on September 17, 2026: a large payment is
  // estimated from the same evidence as a small one.
  const input = example();
  input.transaction.amountMinor = '-300001';
  assert.equal(estimateHistoricalSpending(input, options).status, 'estimated');
  input.transaction.amountMinor = '-300000';
  assert.equal(estimateHistoricalSpending(input, options).status, 'estimated');
  input.transaction.description = 'Переказ на картку';
  assert.equal(
    estimateHistoricalSpending(input, options).status,
    'needs_review',
  );
});
test('missing exact daily UAH conversion keeps a payment in review', () => {
  const input = example();
  input.transaction.currency = 'EUR';
  input.uah.amountMinor = null;
  const result = estimateHistoricalSpending(input, options);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'missing_or_invalid_daily_uah_conversion');
});
test('current plausible proposal can estimate; stale, renamed, conflict and malformed scores cannot', () => {
  const input = example();
  input.sourceDetails = {};
  input.cachedProposal = {
    id: 'proposal',
    revision: 3,
    state: 'ready',
    decision: {
      kind: 'personal_expense',
      category: 'Pets',
      confidence: 0.75,
      explanation: 'synthetic merchant',
    },
  };
  assert.equal(
    estimateHistoricalSpending(input, options).method,
    'cached_model',
  );
  const fingerprint = estimateHistoricalSpending(
    input,
    options,
  ).evidenceFingerprint;
  input.transaction.revision++;
  assert.equal(
    estimateHistoricalSpending(input, options).status,
    'needs_review',
  );
  assert.notEqual(
    fingerprint,
    estimateHistoricalSpending(input, options).evidenceFingerprint,
  );
  input.transaction.revision--;
  input.categoryPaths = [];
  assert.equal(
    estimateHistoricalSpending(input, options).status,
    'needs_review',
  );
  input.categoryPaths = ['Pets'];
  input.cachedProposal.decision.confidence = 2;
  assert.equal(
    estimateHistoricalSpending(input, options).status,
    'needs_review',
  );
  input.cachedProposal.decision.confidence = 0.75;
  input.sourceDetails = { mcc: 5411 };
  assert.equal(
    estimateHistoricalSpending(input, options).reason,
    'conflicting_merchant_and_model_evidence',
  );
});
test('large estimates require both specific merchant MCC and matching cached proposal', () => {
  const input = example();
  input.transaction.amountMinor = '-900000';
  input.cachedProposal = {
    id: 'proposal',
    revision: 3,
    state: 'ready',
    decision: {
      kind: 'personal_expense',
      category: 'Food / Groceries',
      confidence: 0.8,
      explanation: 'synthetic',
    },
  };
  assert.equal(estimateHistoricalSpending(input, options).status, 'estimated');
  // Since September 17, 2026 the amount no longer demands a specific merchant:
  // the cached proposal alone estimates a large payment as it does a small one.
  input.sourceDetails = {};
  assert.equal(estimateHistoricalSpending(input, options).status, 'estimated');
});
