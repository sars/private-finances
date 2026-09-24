import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runScheduledSync } from '../src/schedule.js';

/**
 * Kate's Monobank, 23 September 2026: the nightly upgrade restarted PostgreSQL
 * four minutes into an import, the import died without recording anything
 * about the bank, and its latch stopped the connection for a day. A run that
 * died before hearing from the bank is retried on the transient backoff,
 * measured from when it began; a latch with any other history stays put.
 */
test('a latch left by a run that died mid-import is lifted on the transient backoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-interrupted-'));
  const latch = join(directory, 'monobank-katya.blocked');
  let calls = 0;
  let result: 'blocked' | 'success' = 'blocked';
  let startedAt: number | null = null;
  const options = {
    instance: 'monobank-katya',
    now: new Date(),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return result;
    },
    interruptedAttemptAt: async () => startedAt,
  };
  try {
    // The run dies and reports nothing the scheduler knows.
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);
    const latchedAt = (await lstat(latch)).mtimeMs;

    // An open attempt from long before this latch is some other run's.
    startedAt = latchedAt - 3600000;
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);

    // The attempt that run opened was never closed. Half an hour on, the first
    // retry is still half an hour away: the latch goes, the wait is recorded.
    startedAt = latchedAt + 200;
    options.now = new Date(startedAt + 30 * 60000);
    assert.equal(await runScheduledSync(options), 'deferred');
    assert.equal(calls, 1);
    await assert.rejects(lstat(latch));
    assert.equal(
      (
        await readFile(join(directory, 'monobank-katya.retry-reason'), 'utf8')
      ).trim(),
      'transient',
    );
    assert.equal(
      Number(
        await readFile(join(directory, 'monobank-katya.retry-after'), 'utf8'),
      ),
      startedAt + 3600000,
    );

    // Once the hour has passed, the bank is asked again.
    result = 'success';
    options.now = new Date(startedAt + 61 * 60000);
    assert.equal(await runScheduledSync(options), 'success');
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a run found dead long after it began is retried at once, and a second death waits longer', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'pf-schedule-interrupted-late-'),
  );
  const latch = join(directory, 'monobank-katya.blocked');
  const streak = join(directory, 'monobank-katya.transient-streak');
  let calls = 0;
  let startedAt: number | null = null;
  const options = {
    instance: 'monobank-katya',
    now: new Date(),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'blocked' as const;
    },
    interruptedAttemptAt: async () => startedAt,
  };
  try {
    assert.equal(await runScheduledSync(options), 'blocked');
    startedAt = (await lstat(latch)).mtimeMs + 200;
    // A day later, as on the server: the backoff has long elapsed.
    options.now = new Date(startedAt + 27 * 3600000);
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 2);
    assert.equal((await readFile(streak, 'utf8')).trim(), '1');

    // That retry died too. Its own attempt is newer than its latch, so it is
    // lifted again, now on the three-hour step rather than every half hour.
    startedAt = (await lstat(latch)).mtimeMs + 200;
    options.now = new Date(startedAt + 60 * 60000);
    assert.equal(await runScheduledSync(options), 'deferred');
    assert.equal(calls, 2);
    assert.equal((await readFile(streak, 'utf8')).trim(), '2');
    assert.equal(
      Number(
        await readFile(join(directory, 'monobank-katya.retry-after'), 'utf8'),
      ),
      startedAt + 3 * 3600000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
