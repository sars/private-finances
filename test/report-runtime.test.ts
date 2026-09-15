import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import { dueReportKinds, runReportCycle } from '../src/report-cli.js';
import { Repository } from '../src/repository.js';
import { Reports } from '../src/reports.js';

test('PF-008 calendar triggers use Riga Monday and month start, including UTC crossover', () => {
  assert.deepEqual(dueReportKinds(new Date('2026-09-11T06:00:00Z')), []);
  assert.deepEqual(dueReportKinds(new Date('2026-09-13T21:30:00Z')), ['week']);
  assert.deepEqual(dueReportKinds(new Date('2026-08-31T21:30:00Z')), ['month']);
  assert.deepEqual(dueReportKinds(new Date('2026-08-31T21:30:00Z'), 'UTC'), [
    'week',
  ]);
  assert.deepEqual(dueReportKinds(new Date('2026-06-01T06:00:00Z')), [
    'week',
    'month',
  ]);
  assert.deepEqual(dueReportKinds(new Date('2026-01-01T06:00:00Z')), ['month']);
  assert.throws(() => dueReportKinds(new Date('bad')));
  assert.throws(() => dueReportKinds(new Date(), 'Invalid/Zone'));
});

test('PF-008 cycle persists idempotent owner/household reports when both periods are due', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch(
      ['rodion', 'katya'].map((owner) => ({
        source: 'synthetic',
        sourceId: owner,
        accountId: owner,
        owner,
        bookedAt: '2026-05-30T12:00:00Z',
        currency: 'EUR',
        amountMinor: '-123',
        description: 'Synthetic period expense',
      })),
    );
    const reports = new Reports(db);
    assert.deepEqual(await reports.list('all'), []);
    const date = new Date('2026-06-01T06:00:00Z');
    const snapshots = await runReportCycle(db, date);
    assert.equal(snapshots.length, 6);
    assert.deepEqual(await runReportCycle(db, date), snapshots);
    for (const owner of ['rodion', 'katya', 'all'] as const) {
      const saved = await reports.list(owner);
      assert.equal(saved.length, 2);
      assert.equal(
        saved.every((s) => s.version === 1),
        true,
      );
      assert.equal(
        saved.every(
          (s) => s.report.transactionCount === (owner === 'all' ? 2 : 1),
        ),
        true,
      );
      assert.deepEqual(
        new Set(saved.map((s) => s.report.period.kind)),
        new Set(['week', 'month']),
      );
    }
    const weekly = await runReportCycle(db, new Date('2026-06-08T06:00:00Z'));
    assert.equal(weekly.length, 3);
    assert.equal(
      weekly.every((s) => s.report.period.kind === 'week'),
      true,
    );
    // Catch up the latest week first; July 1 then needs only the month.
    await runReportCycle(db, new Date('2026-06-30T06:00:00Z'));
    const monthly = await runReportCycle(db, new Date('2026-07-01T06:00:00Z'));
    assert.equal(monthly.length, 3);
    assert.equal(
      monthly.every((s) => s.report.period.kind === 'month'),
      true,
    );
  } finally {
    await db.close();
  }
});

test('PF-008 missed triggers catch up latest periods once without daily correction revisions', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const transaction = {
      source: 'synthetic',
      sourceId: 'catchup',
      accountId: 'catchup',
      owner: 'rodion',
      bookedAt: '2026-05-30T12:00:00Z',
      currency: 'EUR',
      amountMinor: '-100',
      description: 'Synthetic',
    };
    await repo.importBatch([transaction]);
    // June 1 was both Monday and month start; service recovers on Tuesday.
    const first = await runReportCycle(db, new Date('2026-06-02T06:00:00Z'));
    assert.equal(first.length, 6);
    assert.equal(
      first.every((s) => s.version === 1),
      true,
    );
    assert.deepEqual(
      await runReportCycle(db, new Date('2026-06-02T07:00:00Z')),
      [],
    );
    await repo.importBatch([{ ...transaction, amountMinor: '-200' }]);
    assert.deepEqual(
      await runReportCycle(db, new Date('2026-06-03T06:00:00Z')),
      [],
    );
    const reports = new Reports(db);
    assert.deepEqual(
      (await reports.list('all')).map((s) => s.version),
      [1, 1],
    );
    // Explicit replay of the due date still refreshes corrections for that period.
    const refreshed = await runReportCycle(
      db,
      new Date('2026-06-01T06:00:00Z'),
    );
    assert.equal(refreshed.length, 6);
    assert.equal(
      refreshed
        .filter((s) => s.report.owner !== 'katya')
        .every((s) => s.version === 2),
      true,
    );
    assert.equal(
      refreshed
        .filter((s) => s.report.owner === 'katya')
        .every((s) => s.version === 1),
      true,
    );
    assert.deepEqual(
      await runReportCycle(db, new Date('2026-06-04T06:00:00Z')),
      [],
    );
    // Catchup is bounded: only the latest complete week/month after a long outage.
    const later = await runReportCycle(db, new Date('2026-09-11T06:00:00Z'));
    assert.equal(later.length, 6);
    assert.equal(new Set(later.map((s) => s.report.period.from)).size, 2);
    assert.deepEqual(
      await runReportCycle(db, new Date('2026-09-12T06:00:00Z')),
      [],
    );
  } finally {
    await db.close();
  }
});
