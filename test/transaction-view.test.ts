import test from 'node:test';
import assert from 'node:assert/strict';
const { transactionView } = await import(
  new URL('../../frontend/src/lib/transaction-view.ts', import.meta.url).href
);
test('transaction browsing includes current payments by default, preserves review links and opens older direct links', () => {
  assert.deepEqual(transactionView(''), { all: true, window: 'current_month' });
  assert.deepEqual(transactionView('?all=0&window=previous_month'), {
    all: false,
    window: 'previous_month',
  });
  assert.deepEqual(transactionView('?all=1&window=current_month'), {
    all: true,
    window: 'current_month',
  });
  assert.deepEqual(transactionView('?id=payment&all=0&window=previous_month'), {
    all: true,
    window: 'all',
  });
});
