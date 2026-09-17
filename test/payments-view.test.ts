import test from 'node:test';
import assert from 'node:assert/strict';

const { paymentSearch, buildPaymentContext } = await import(
  new URL('../../frontend/src/lib/payments.ts', import.meta.url).href
);

test('the list request has one spelling per set of filters, and drops what is empty', () => {
  assert.equal(
    paymentSearch({ q: 'rimi', review: '1', owner: 'katya', display: '' }),
    'owner=katya&review=1&q=rimi&limit=50',
  );
  // Key order is fixed, so equal filters written in another order share a
  // cache entry; the cursor and page size come last.
  assert.equal(
    paymentSearch({ display: 'EUR', owner: 'rodion' }, 'abc', 7),
    paymentSearch({ owner: 'rodion', display: 'EUR' }, 'abc', 7),
  );
  assert.ok(
    paymentSearch({}, 'cursor-id', 7).endsWith('limit=7&cursor=cursor-id'),
  );
  // A parameter the endpoint does not know is never sent.
  assert.equal(
    paymentSearch({ tab: 'payments' } as Record<string, string>),
    'limit=50',
  );
});

test('a row reads its facts from lookups built once over all the pages', () => {
  const page = (
    id: string,
    revision: number,
    more: Record<string, unknown>,
  ) => ({
    transactions: [
      {
        id,
        owner: 'rodion',
        bookedAt: '2026-09-01T10:00:00Z',
        currency: 'UAH',
        amountMinor: '-100',
        description: 'Synthetic',
        kind: 'unresolved',
        category: null,
        revision,
      },
    ],
    total: 2,
    nextCursor: null,
    triage: [],
    suggestions: {},
    tags: {},
    receipts: {},
    ...more,
  });
  const context = buildPaymentContext([
    page('a', 3, {
      historicalEstimates: [
        {
          transactionId: 'a',
          status: 'estimated',
          category: 'Food',
          method: 'mcc',
        },
        {
          transactionId: 'a',
          status: 'needs_review',
          category: null,
          method: null,
        },
      ],
      triage: [
        {
          transaction_id: 'a',
          revision: 3,
          state: 'ready',
          decision: { kind: 'personal_expense', category: 'Food' },
        },
      ],
      tags: { a: [{ id: 't1', name: 'holiday' }] },
      receipts: { a: 2 },
      reporting: {
        currency: 'EUR',
        rows: [
          {
            id: 'a',
            convertedAmountMinor: '-3',
            netAmountMinor: '-3',
            method: 'daily',
          },
        ],
      },
    }),
    page('b', 5, {
      // A suggestion for an older revision of the payment is not a suggestion.
      triage: [
        {
          transaction_id: 'b',
          revision: 4,
          state: 'ready',
          decision: { kind: 'personal_expense', category: 'Taxi' },
        },
      ],
      tags: { b: [] },
      reporting: {
        currency: 'EUR',
        rows: [
          {
            id: 'b',
            convertedAmountMinor: '-5',
            netAmountMinor: null,
            method: 'daily',
          },
        ],
      },
    }),
  ]);
  assert.equal(context.estimate.get('a')?.category, 'Food');
  assert.equal(context.recognized.get('a')?.decision?.category, 'Food');
  assert.equal(context.recognized.has('b'), false);
  assert.deepEqual(
    context.tags.a.map((t: { name: string }) => t.name),
    ['holiday'],
  );
  assert.deepEqual(context.tags.b, []);
  assert.equal(context.receipts.a, 2);
  assert.equal(context.receipts.b, undefined);
  assert.equal(context.reporting?.currency, 'EUR');
  assert.deepEqual(
    context.reporting?.rows.map((r: { id: string }) => r.id),
    ['a', 'b'],
  );
  assert.equal(buildPaymentContext([]).reporting, undefined);
});
