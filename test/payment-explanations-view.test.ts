import test from 'node:test';
import assert from 'node:assert/strict';
const { explanationSuggestion, suggestionFeedback } = await import(
  new URL('../../frontend/src/lib/payment-explanations.ts', import.meta.url)
    .href
);

test('valid suggestion supplies only decision fields and malformed responses cannot prefill them', () => {
  const value = {
    kind: 'personal_expense',
    category: 'Food / Restaurants / Dining in',
    confidence: 0.9,
    explanation: 'Synthetic meal',
  };
  assert.deepEqual(explanationSuggestion(value), value);
  for (const bad of [
    undefined,
    null,
    { ...value, kind: 'execute' },
    { ...value, confidence: Infinity },
    { ...value, confidence: 1.2 },
    { ...value, category: {} },
    { ...value, explanation: null },
  ])
    assert.equal(explanationSuggestion(bad), null);
  assert.equal(
    explanationSuggestion({ ...value, kind: 'investment', category: null })
      ?.kind,
    'investment',
  );
});

test('saved explanations remain visible when suggestions fail or are unavailable; successful proposals still require confirmation', () => {
  assert.match(suggestionFeedback('proposed'), /saved.*confirm/i);
  for (const state of [
    'waiting',
    'budget_exhausted',
    'disabled',
    'failed',
    'stale',
    'uncertain',
  ]) {
    const result = suggestionFeedback(state);
    assert.match(result, /Explanation saved/);
    assert.doesNotMatch(
      result,
      /decision (saved|confirmed)|automatically categorized/i,
    );
  }
  assert.match(suggestionFeedback('stale'), /refresh/i);
});
