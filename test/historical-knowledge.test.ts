import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadHistoricalKnowledge,
  matchHistoricalKnowledge,
  validateHistoricalKnowledge,
  type HistoricalEvidence,
  type HistoricalKnowledge,
  type HistoricalTransaction,
} from '../src/historical-knowledge.js';

const entry: HistoricalEvidence = {
  id: 'synthetic-insurance',
  owner: 'rodion',
  sourceReference: 'synthetic-source:owner-statement',
  kind: 'scoped_fact',
  proposedKind: 'non_personal',
  statement: 'Owner confirmed this was an insurance reimbursement.',
  match: {
    source: 'synthetic-bank',
    accountId: 'synthetic-account',
    description: 'Synthetic reimbursement',
    currency: 'EUR',
    direction: 'inflow',
    amountMinor: '12345',
    from: '2026-07-01',
    to: '2026-07-31',
  },
};
const transaction: HistoricalTransaction = {
  owner: 'rodion',
  source: 'synthetic-bank',
  accountId: 'synthetic-account',
  description: 'Synthetic reimbursement',
  currency: 'EUR',
  amountMinor: '12345',
  bookedAt: '2026-07-15T12:00:00Z',
};
const knowledge = (
  entries: HistoricalEvidence[] = [entry],
): HistoricalKnowledge => ({ schemaVersion: 1, entries });

test('historical facts require exact owner, bank, account, text, amount, currency and dates', () => {
  assert.equal(matchHistoricalKnowledge(knowledge(), transaction).length, 1);
  const changes: Partial<HistoricalTransaction>[] = [
    { owner: 'katya' },
    { source: 'another-bank' },
    { accountId: 'another-account' },
    { description: 'synthetic reimbursement' },
    { description: 'Synthetic reimbursement ' },
    { description: 'Synthetic reimbursement extra' },
    { currency: 'USD' },
    { amountMinor: '-12345' },
    { amountMinor: '12346' },
    { bookedAt: '2026-06-30T23:59:59Z' },
    { bookedAt: '2026-08-01T00:00:00Z' },
    { bookedAt: 'invalid' },
    { amountMinor: '1.2345' },
  ];
  for (const change of changes)
    assert.deepEqual(
      matchHistoricalKnowledge(knowledge(), { ...transaction, ...change }),
      [],
    );
  for (const bookedAt of ['2026-07-01T00:00:00Z', '2026-07-31T23:59:59.999Z']) {
    assert.equal(
      matchHistoricalKnowledge(knowledge(), { ...transaction, bookedAt })
        .length,
      1,
    );
  }
  assert.equal(
    matchHistoricalKnowledge(knowledge(), {
      ...transaction,
      amountMinor: '+0012345',
    }).length,
    1,
  );
});

test('context remains exact and output excludes match values with at most three statements', () => {
  const context: HistoricalEvidence = {
    ...entry,
    kind: 'context',
    match: {
      source: entry.match.source,
      description: entry.match.description,
      currency: 'EUR',
      direction: 'inflow',
    },
  };
  const result = matchHistoricalKnowledge(
    knowledge(
      Array.from({ length: 3 }, (_, index) => ({
        ...context,
        id: `synthetic-${index}`,
      })),
    ),
    transaction,
  );
  assert.equal(result.length, 3);
  assert.deepEqual(Object.keys(result[0]!).sort(), [
    'id',
    'proposedKind',
    'sourceReference',
    'statement',
  ]);
  assert.ok(!JSON.stringify(result).includes(transaction.accountId));
  assert.ok(!JSON.stringify(result).includes(transaction.amountMinor));
  assert.throws(
    () =>
      matchHistoricalKnowledge(
        knowledge(
          Array.from({ length: 4 }, (_, index) => ({
            ...context,
            id: `synthetic-${index}`,
            proposedKind: index === 3 ? 'investment' : 'non_personal',
          })),
        ),
        transaction,
      ),
    { message: 'historical_knowledge_ambiguous' },
  );
  for (const amountMinor of ['-12345', '0'])
    assert.deepEqual(
      matchHistoricalKnowledge(knowledge([context]), {
        ...transaction,
        amountMinor,
      }),
      [],
    );
  assert.deepEqual(
    matchHistoricalKnowledge(knowledge([context]), {
      ...transaction,
      description: 'Synthetic reimbursement at another merchant',
    }),
    [],
  );
  assert.deepEqual(
    matchHistoricalKnowledge(knowledge([context]), {
      ...transaction,
      owner: 'katya',
    }),
    [],
  );
});

test('malformed schemas and incomplete scopes fail closed without source contents', () => {
  const invalidValues: unknown[] = [
    null,
    [],
    {},
    { ...knowledge(), schemaVersion: 2 },
    { ...knowledge(), unexpected: 'private' },
    knowledge([entry, entry]),
    knowledge([{ ...entry, statement: 'a'.repeat(401) }]),
    knowledge([{ ...entry, sourceReference: '/private/source.json' }]),
    knowledge(
      Array.from({ length: 101 }, (_, index) => ({
        ...entry,
        id: `synthetic-${index}`,
      })),
    ),
  ];
  for (const key of [
    'owner',
    'id',
    'sourceReference',
    'statement',
    'kind',
    'proposedKind',
    'match',
  ]) {
    const changed = { ...entry } as Record<string, unknown>;
    delete changed[key];
    invalidValues.push({ schemaVersion: 1, entries: [changed] });
  }
  for (const key of [
    'source',
    'description',
    'currency',
    'direction',
    'amountMinor',
    'from',
    'to',
  ]) {
    const match = { ...entry.match } as Record<string, unknown>;
    delete match[key];
    invalidValues.push({ schemaVersion: 1, entries: [{ ...entry, match }] });
  }
  for (const match of [
    { ...entry.match, from: '2026-02-30' },
    { ...entry.match, to: '2026-06-01' },
    { ...entry.match, amountMinor: 12345 },
    { ...entry.match, description: '' },
    { ...entry.match, fuzzy: true },
    { ...entry.match, currency: 'eur' },
    { ...entry.match, direction: 'outflow' },
  ])
    invalidValues.push({ schemaVersion: 1, entries: [{ ...entry, match }] });
  for (const value of invalidValues)
    assert.throws(() => validateHistoricalKnowledge(value), {
      message: 'historical_knowledge_invalid',
    });
});

test('loader accepts a private file and rejects missing, public, oversized and malformed files generically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'historical-knowledge-'));
  const path = join(directory, 'synthetic.json');
  try {
    await assert.rejects(loadHistoricalKnowledge(path), {
      message: 'historical_knowledge_unavailable',
    });
    await writeFile(path, JSON.stringify(knowledge()), { mode: 0o600 });
    assert.deepEqual(await loadHistoricalKnowledge(path), knowledge());
    await chmod(path, 0o644);
    await assert.rejects(loadHistoricalKnowledge(path), {
      message: 'historical_knowledge_unavailable',
    });
    await chmod(path, 0o600);
    for (const content of [
      'private malformed data',
      ' '.repeat(65537),
      Buffer.from([0xff]),
    ]) {
      await writeFile(path, content);
      await assert.rejects(loadHistoricalKnowledge(path), {
        message: 'historical_knowledge_unavailable',
      });
    }
    await assert.rejects(loadHistoricalKnowledge(directory), {
      message: 'historical_knowledge_unavailable',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
