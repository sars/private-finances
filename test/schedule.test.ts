import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  chmod,
  lstat,
  readFile,
  readdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  dailyReplayWindow,
  parseInstance,
  runScheduledSync,
  verifiedMarker,
  scheduleEnabled,
} from '../src/schedule.js';

test('PF-002 bank invocation requires both restore and connector enable markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-markers-'));
  let calls = 0;
  const instance = 'monobank-rodion';
  const options = {
    instance,
    now: new Date(),
    stateDirectory: directory,
    ready: () => scheduleEnabled(directory, instance, process.getuid!()),
    invoke: async () => {
      calls++;
      return 'success' as const;
    },
  };
  try {
    await mkdir(join(directory, 'schedules'));
    assert.equal(await runScheduledSync(options), 'disabled');
    await writeFile(
      join(directory, 'schedules', `${instance}.enabled`),
      instance,
      { mode: 0o600 },
    );
    assert.equal(await runScheduledSync(options), 'disabled');
    await rm(join(directory, 'schedules', `${instance}.enabled`));
    await writeFile(
      join(directory, 'off-server-restore-verified'),
      'off-server-restore-verified',
      { mode: 0o600 },
    );
    assert.equal(await runScheduledSync(options), 'disabled');
    assert.equal(calls, 0);
    await writeFile(
      join(directory, 'schedules', `${instance}.enabled`),
      instance,
      { mode: 0o600 },
    );
    assert.equal(await runScheduledSync(options), 'success');
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PF-002 verified local recovery permits only explicitly enabled instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-local-recovery-'));
  const instance = 'monobank-rodion';
  const uid = process.getuid!();
  const marker = join(directory, 'local-restore-verified');
  let calls = 0;
  const options = {
    instance,
    now: new Date(),
    stateDirectory: directory,
    ready: () => scheduleEnabled(directory, instance, uid),
    invoke: async () => {
      calls++;
      return 'success' as const;
    },
  };
  try {
    await mkdir(join(directory, 'schedules'));
    const enable = join(directory, 'schedules', `${instance}.enabled`);
    await writeFile(enable, instance, { mode: 0o600 });
    assert.equal(await runScheduledSync(options), 'disabled');
    await writeFile(marker, 'off-server-restore-verified', { mode: 0o600 });
    assert.equal(await runScheduledSync(options), 'disabled');
    await writeFile(marker, 'local-restore-verified');
    assert.equal(await scheduleEnabled(directory, instance, uid + 1), false);
    await chmod(marker, 0o666);
    assert.equal(await runScheduledSync(options), 'disabled');
    await chmod(marker, 0o600);
    await rm(enable);
    assert.equal(await runScheduledSync(options), 'disabled');
    await writeFile(enable, 'monobank-katya', { mode: 0o600 });
    assert.equal(await runScheduledSync(options), 'disabled');
    assert.equal(calls, 0);
    await writeFile(enable, instance);
    assert.equal(await runScheduledSync(options), 'success');
    assert.equal(calls, 1);
    assert.equal(
      await scheduleEnabled(directory, 'monobank-katya', uid),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PF-002 rolling replay includes today and spans exactly 31 days across leap year and DST', () => {
  assert.deepEqual(dailyReplayWindow(new Date('2024-03-31T23:30:00-04:00')), {
    from: '2024-03-01T03:30:00.000Z',
    to: '2024-04-01T03:30:00.000Z',
  });
  assert.deepEqual(dailyReplayWindow(new Date('2024-03-01T12:00:00Z')), {
    from: '2024-01-30T12:00:00.000Z',
    to: '2024-03-01T12:00:00.000Z',
  });
  assert.deepEqual(dailyReplayWindow(new Date('2026-01-01T00:00:00Z')), {
    from: '2025-12-01T00:00:00.000Z',
    to: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(() => dailyReplayWindow(new Date('bad')));
  assert.throws(() => parseInstance('../monobank-rodion'));
});

test('PF-002 missing, untrusted, writable and symlink markers fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-gate-'));
  const path = join(directory, 'marker');
  const uid = process.getuid!();
  try {
    assert.equal(await verifiedMarker(path, 'verified', uid), false);
    await writeFile(path, 'verified\n', { mode: 0o600 });
    assert.equal(await verifiedMarker(path, 'verified', uid), true);
    assert.equal(await verifiedMarker(path, 'verified', uid + 1), false);
    assert.equal(await verifiedMarker(path, 'different', uid), false);
    await symlink(path, join(directory, 'link'));
    assert.equal(
      await verifiedMarker(join(directory, 'link'), 'verified', uid),
      false,
    );
    await chmod(path, 0o666);
    assert.equal(await verifiedMarker(path, 'verified', uid), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PF-002 disabled guard makes no invocation; success replays identical bounded window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-run-'));
  const calls: string[][] = [];
  const options = {
    instance: 'monobank-rodion',
    now: new Date('2026-09-11T03:00:00Z'),
    stateDirectory: directory,
    ready: async () => false,
    invoke: async (args: string[]) => {
      calls.push(args);
      return 'success' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'disabled');
    assert.equal(calls.length, 0);
    options.ready = async () => true;
    assert.equal(await runScheduledSync(options), 'success');
    assert.equal(await runScheduledSync(options), 'success');
    assert.deepEqual(
      calls,
      Array(2).fill([
        'monobank',
        'rodion',
        '2026-08-11T03:00:00.000Z',
        '2026-09-11T03:00:00.000Z',
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PF-002 auth or uncertain failure latches only that connector; transient has no immediate retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-failure-'));
  let calls = 0;
  const options = {
    instance: 'enablebanking-katya-wise',
    now: new Date('2026-09-11T03:00:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'blocked' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);
    const transient = {
      ...options,
      instance: 'monobank-katya',
      invoke: async () => {
        calls++;
        return 'transient' as const;
      },
    };
    assert.equal(await runScheduledSync(transient), 'transient');
    assert.equal(calls, 2);
    assert.equal(await runScheduledSync(transient), 'deferred');
    assert.equal(calls, 2);
    const crash = {
      ...options,
      instance: 'monobank-rodion',
      invoke: async (): Promise<never> => {
        throw new Error('simulated crash');
      },
    };
    await assert.rejects(runScheduledSync(crash), /simulated crash/);
    assert.equal(await runScheduledSync(crash), 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bank the owner has not approved yet is retried on the next tick, never latched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-consent-'));
  let calls = 0;
  const options = {
    instance: 'enablebanking-rodion-lhv',
    now: new Date('2026-09-17T03:00:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'consent_pending' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'consent_pending');
    assert.equal(await runScheduledSync(options), 'consent_pending');
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('per-bank schedules pass the selected bank and isolate blocked consent', async () => {
  for (const invalid of [
    'enablebanking-rodion',
    'monobank-rodion-wise',
    'enablebanking-katya-other',
  ])
    assert.throws(() => parseInstance(invalid));
  const directory = await mkdtemp(join(tmpdir(), 'pf-bank-schedules-'));
  const calls: string[][] = [];
  const options = {
    instance: 'enablebanking-rodion-wise',
    now: new Date('2026-09-11T03:00:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async (args: string[]) => {
      calls.push(args);
      return 'blocked' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(
      await runScheduledSync({
        ...options,
        instance: 'enablebanking-rodion-revolut',
        invoke: async (args) => {
          calls.push(args);
          return 'success';
        },
      }),
      'success',
    );
    assert.deepEqual(
      calls.map((args) => [args[0], args[1], args[4]]),
      [
        ['enablebanking', 'rodion', 'wise'],
        ['enablebanking', 'rodion', 'revolut'],
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Enable Banking success cannot repeat within six hours, even after a timer restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-bank-frequency-'));
  let calls = 0;
  const options = {
    instance: 'enablebanking-rodion-wise',
    now: new Date(),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'success' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'success');
    const retryAt = Number(
      await readFile(
        join(directory, `${options.instance}.retry-after`),
        'utf8',
      ),
    );
    assert.ok(retryAt >= options.now.getTime() + 6 * 3600000);
    assert.equal(
      await runScheduledSync({ ...options, now: new Date(retryAt - 1) }),
      'deferred',
    );
    assert.equal(calls, 1);
    assert.equal(
      await runScheduledSync({ ...options, now: new Date(retryAt) }),
      'success',
    );
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const minutes of [30, 60]) {
  test(`${minutes}-minute trial persists fallback after rate limits or transient failures, isolated by bank`, async () => {
    for (const failure of ['rate_limit', 'transient'] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'pf-hourly-trial-'));
      const instance = 'enablebanking-rodion-wise';
      const now = new Date();
      const options = {
        instance,
        now,
        stateDirectory: directory,
        ready: async () => true,
        hourlyPolling: true,
        halfHourlyPolling: minutes === 30,
        invoke: async () => 'success' as const,
      };
      try {
        assert.equal(await runScheduledSync(options), 'success');
        const initial = Number(
          await readFile(join(directory, `${instance}.retry-after`), 'utf8'),
        );
        assert.ok(
          initial >= now.getTime() + minutes * 60000 &&
            initial < now.getTime() + minutes * 60000 + 10000,
        );
        assert.equal(
          await runScheduledSync({ ...options, now: new Date(initial - 1) }),
          'deferred',
        );
        assert.equal(
          await runScheduledSync({
            ...options,
            now: new Date(initial),
            invoke: async () => failure,
          }),
          failure,
        );
        assert.equal(
          (
            await readFile(join(directory, `${instance}.conservative`), 'utf8')
          ).trim(),
          failure,
        );
        const retry = Number(
          await readFile(join(directory, `${instance}.retry-after`), 'utf8'),
        );
        // A rate limit is the provider refusing work and keeps the flat twelve
        // hours; a first transient failure is a blip and waits only an hour.
        const wait = failure === 'transient' ? 3600000 : 43200000;
        assert.ok(retry >= initial + wait);
        assert.ok(retry < initial + wait + 60000);
        assert.equal(
          await runScheduledSync({ ...options, now: new Date(retry - 1) }),
          'deferred',
        );
        assert.equal(
          await runScheduledSync({ ...options, now: new Date(retry) }),
          'success',
        );
        const slow = Number(
          await readFile(join(directory, `${instance}.retry-after`), 'utf8'),
        );
        assert.equal(slow, retry + 6 * 3600000);
        assert.equal(
          await runScheduledSync({
            ...options,
            instance: 'enablebanking-rodion-revolut',
          }),
          'success',
        );
        const other = Number(
          await readFile(
            join(directory, 'enablebanking-rodion-revolut.retry-after'),
            'utf8',
          ),
        );
        assert.ok(
          other >= now.getTime() + minutes * 60000 &&
            other < now.getTime() + minutes * 60000 + 10000,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}

test('a transient failure backs off an hour, then three, then a day, and a success clears it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-transient-ladder-'));
  const instance = 'monobank-katya';
  const streak = join(directory, `${instance}.transient-streak`);
  const cooldown = join(directory, `${instance}.retry-after`);
  const base = { instance, stateDirectory: directory, ready: async () => true };
  const failing = { ...base, invoke: async () => 'transient' as const };
  const read = async (path: string) => Number(await readFile(path, 'utf8'));
  try {
    // The bank is unreachable for a few minutes, the way Monobank is most
    // nights. Each further failure waits longer, but the first two are short
    // enough that an outage costs a poll rather than a day of imports.
    let now = new Date();
    for (const expected of [3600000, 10800000, 86400000, 86400000]) {
      assert.equal(await runScheduledSync({ ...failing, now }), 'transient');
      const retry = await read(cooldown);
      assert.ok(
        retry >= now.getTime() + expected &&
          retry < now.getTime() + expected + 60000,
        `expected ${expected}ms, waited ${retry - now.getTime()}ms`,
      );
      // Nothing may reach the bank before the cooldown is up.
      assert.equal(
        await runScheduledSync({ ...failing, now: new Date(retry - 1) }),
        'deferred',
      );
      now = new Date(retry);
    }
    assert.equal(await read(streak), 4);
    assert.equal(
      await runScheduledSync({
        ...base,
        now,
        invoke: async () => 'success' as const,
      }),
      'success',
    );
    const remaining = (await readdir(directory)).filter((name) =>
      name.endsWith('.transient-streak'),
    );
    assert.deepEqual(remaining, []);
    // Having forgotten the streak, the next lone failure waits an hour again.
    const later = new Date(now.getTime() + 1);
    assert.equal(
      await runScheduledSync({ ...failing, now: later }),
      'transient',
    );
    assert.ok((await read(cooldown)) < later.getTime() + 3600000 + 60000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a streak file that is not a count waits the longest, never the shortest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-transient-corrupt-'));
  const instance = 'monobank-rodion';
  try {
    await writeFile(
      join(directory, `${instance}.transient-streak`),
      'nonsense',
    );
    const now = new Date();
    assert.equal(
      await runScheduledSync({
        instance,
        now,
        stateDirectory: directory,
        ready: async () => true,
        invoke: async () => 'transient' as const,
      }),
      'transient',
    );
    const retry = Number(
      await readFile(join(directory, `${instance}.retry-after`), 'utf8'),
    );
    assert.ok(retry >= now.getTime() + 86400000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Revolut, 21 September 2026: the consent expired, the half-hourly run latched
 * it, and the owner re-approved about three hours later. Nothing read that
 * approval, so the connection went on being skipped without a single request to
 * the bank — thirty runs, fifteen hours, and a screen still saying it had
 * stopped. An approval is the person the latch was waiting for.
 */
test('an approval the owner has already given lifts the latch, once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-reconsent-'));
  const tick = () => new Promise((done) => setTimeout(done, 20));
  const latch = join(directory, 'enablebanking-rodion-revolut.blocked');
  let calls = 0;
  let approvedAt: number | null = null;
  const options = {
    instance: 'enablebanking-rodion-revolut',
    now: new Date('2026-09-21T18:07:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'blocked' as const;
    },
    consentRenewedAt: async () => approvedAt,
  };
  try {
    // The consent expires: one failed attempt, then silence.
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);

    // The approval that expired is older than the latch it caused, and lifting
    // on it would retry the very consent the bank has already refused.
    approvedAt = (await lstat(latch)).mtimeMs - 1000;
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);

    // The owner approves again on the Bank connections page, and the next tick
    // tries the bank without anyone typing anything on the server.
    await tick();
    approvedAt = Date.now();
    await tick();
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 2);

    // That attempt failed too, so the connection is waiting for a person again
    // rather than calling the bank every half hour on a dead approval.
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('re-approving a latched bank restores its imports with no server command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-recovery-'));
  const tick = () => new Promise((done) => setTimeout(done, 20));
  let approvedAt: number | null = null;
  let expired = true;
  const options = {
    instance: 'enablebanking-rodion-revolut',
    now: new Date('2026-09-21T18:07:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => (expired ? ('blocked' as const) : ('success' as const)),
    consentRenewedAt: async () => approvedAt,
  };
  try {
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    await tick();
    approvedAt = Date.now();
    expired = false;
    await tick();
    assert.equal(await runScheduledSync(options), 'success');
    // The latch is gone and the connection is back on its polling interval,
    // which is what the owner sees as the bank importing again.
    assert.equal(
      (await readdir(directory)).includes(
        'enablebanking-rodion-revolut.blocked',
      ),
      false,
    );
    assert.equal(
      (
        await readFile(
          join(directory, 'enablebanking-rodion-revolut.retry-reason'),
          'utf8',
        )
      ).trim(),
      'polling_interval',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bank with no approval to renew keeps its latch final', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-schedule-token-latch-'));
  let calls = 0;
  const options = {
    instance: 'monobank-rodion',
    now: new Date('2026-09-21T18:07:00Z'),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      calls++;
      return 'blocked' as const;
    },
  };
  try {
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(await runScheduledSync(options), 'blocked');
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
