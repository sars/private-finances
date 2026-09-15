import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCategorization,
  type ReferenceCase,
} from '../src/categorization-evaluation.js';

test('reference evaluation separates false approvals, abstentions and inferred labels', () => {
  const cases: ReferenceCase[] = [
    {
      expected: { kind: 'personal_expense', category: 'Pets' },
      actual: { kind: 'personal_expense', category: 'Pets' },
      authority: 'owner_confirmed',
      split: 'holdout',
    },
    {
      expected: { kind: 'investment', category: null },
      actual: { kind: 'personal_expense', category: 'Shopping' },
      authority: 'owner_confirmed',
      split: 'holdout',
    },
    {
      expected: { kind: 'personal_expense', category: 'Food / Groceries' },
      actual: { kind: 'unresolved', category: null },
      authority: 'reviewed_inference',
      split: 'development',
    },
    {
      expected: { kind: 'unresolved', category: null },
      actual: { kind: 'unresolved', category: null },
      authority: 'reviewed_inference',
      split: 'holdout',
    },
    {
      expected: { kind: 'unresolved', category: null },
      actual: { kind: 'personal_expense', category: 'Other' },
      authority: 'reviewed_inference',
      split: 'development',
    },
  ];
  const result = evaluateCategorization(cases);
  assert.equal(result.overall.correct, 1);
  assert.equal(result.overall.wrongApproval, 2);
  assert.equal(result.overall.abstained, 1);
  assert.equal(result.overall.safeAbstention, 1);
  assert.equal(result.overall.approvalPrecision, 1 / 3);
  assert.equal(result.overall.correctCoverage, 1 / 3);
  assert.equal(result.ownerConfirmed.approvalPrecision, 0.5);
  assert.equal(result.holdout.cases, 3);
  assert.equal(result.development.cases, 2);
  assert.equal(result.inferred.correct, 0);
});

test('empty reference is unavailable rather than perfect accuracy', () => {
  const result = evaluateCategorization([]);
  assert.equal(result.overall.approvalPrecision, null);
  assert.equal(result.overall.correctCoverage, null);
});
