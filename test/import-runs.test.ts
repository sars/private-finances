import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { syncBank } from '../src/bank-sync.js';
import {
  AttemptRecorder,
  importRun,
  importRuns,
  recordNextAttempt,
  sanitizePath,
} from '../src/import-runs.js';
import { importStatus } from '../src/import-status.js';
import { systemProblems } from '../src/problems.js';
import { runScheduledSync } from '../src/schedule.js';
import { requester } from '../src/connectors/http.js';
import {
  ConnectorError,
  type BankConnector,
  type BankAccount,
} from '../src/connectors/types.js';
import { synthetic } from '../src/synthetic.js';

const account: BankAccount = {
  source: 'monobank',
  owner: 'rodion',
  accountId: 'a',
  providerAccountId: 'a',
  currency: 'UAH',
  label: 'Test',
};
function connectorThat(
  transactions: BankConnector['transactions'],
): BankConnector {
  return {
    source: 'monobank',
    owner: 'rodion',
    accounts: async () => [account],
    transactions,
  };
}
const ONE = {
  ...synthetic[0]!,
  source: 'monobank' as const,
  accountId: 'a',
  status: 'booked' as const,
  sourceDetails: {},
};

test('a failed import is recorded as a run, which is the whole point', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');

    // A bank that refuses. Before this record existed it left only an
    // overwritten error code on its connection and no row anywhere.
    const recorder = new AttemptRecorder(db, 'monobank:rodion', from, to);
    await recorder.open();
    await assert.rejects(
      syncBank(
        repo,
        connectorThat(async () => {
          throw new ConnectorError('rate_limit', 43200000);
        }),
        from,
        to,
        recorder,
      ),
    );

    const page = await importRuns(db);
    assert.equal(page.runs.length, 1);
    assert.equal(page.total, 1);
    const [run] = page.runs;
    assert.equal(run!.outcome, 'failed');
    assert.equal(run!.errorCode, 'rate_limit');
    assert.equal(run!.label, 'Monobank');

    // And the failure says where it stopped and what the bank asked for.
    const detail = await importRun(db, run!.id);
    const error = detail!.steps.find((step) => step.stage === 'error');
    assert.equal(error?.code, 'rate_limit');
    assert.equal(error?.retryAfterMs, 43200000);
    // No window committed, so the coverage record stays empty — the two
    // records must not be confused for one another.
    assert.deepEqual(detail!.windows, []);
  } finally {
    await db.close();
  }
});

test('a successful import records its stages, its counts and its coverage', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');
    const recorder = new AttemptRecorder(db, 'monobank:rodion', from, to);
    await recorder.open();
    assert.deepEqual(
      await syncBank(
        repo,
        connectorThat(async () => [ONE]),
        from,
        to,
        recorder,
      ),
      { accounts: 1, changed: 1 },
    );

    const page = await importRuns(db);
    assert.equal(page.runs[0]!.outcome, 'succeeded');
    assert.equal(page.runs[0]!.changed, 1);
    assert.equal(page.runs[0]!.accounts, 1);

    const detail = await importRun(db, page.runs[0]!.id);
    const stages = detail!.steps.map((step) => step.stage);
    for (const stage of ['claim', 'accounts', 'transactions', 'commit'])
      assert.ok(stages.includes(stage as never), `missing stage ${stage}`);
    assert.equal(detail!.windows.length, 1);
    assert.equal(detail!.windows[0]!.changed, 1);
  } finally {
    await db.close();
  }
});

test('runs are filtered by bank and outcome, and paged without repeating a row', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');
    for (let i = 0; i < 5; i++) {
      const recorder = new AttemptRecorder(db, 'monobank:rodion', from, to);
      await recorder.open();
      // Alternate success and failure so both filters have something to find.
      if (i % 2 === 0)
        await syncBank(
          repo,
          connectorThat(async () => [ONE]),
          from,
          to,
          recorder,
        );
      else
        await assert.rejects(
          syncBank(
            repo,
            connectorThat(async () => {
              throw new ConnectorError('transient');
            }),
            from,
            to,
            recorder,
          ),
        );
    }

    assert.equal((await importRuns(db)).total, 5);
    assert.equal((await importRuns(db, { outcome: 'failed' })).total, 2);
    assert.equal((await importRuns(db, { outcome: 'succeeded' })).total, 3);
    assert.equal(
      (await importRuns(db, { connection: 'enablebanking:rodion:wise' })).total,
      0,
    );

    // Walking the pages must visit each run exactly once.
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await importRuns(db, {
        limit: 2,
        cursor: cursor ?? undefined,
      });
      seen.push(...page.runs.map((run) => run.id));
      cursor = page.nextCursor;
      // The cursor reaches SQL as a uuid cast, which PostgreSQL raises on
      // rather than ignoring, so its shape is part of the contract.
      if (cursor)
        assert.match(
          cursor,
          /^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    } while (cursor);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
  } finally {
    await db.close();
  }
});

test('a cursor that is not a cursor returns the first page instead of failing', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');
    const recorder = new AttemptRecorder(db, 'monobank:rodion', from, to);
    await recorder.open();
    await syncBank(
      repo,
      connectorThat(async () => [ONE]),
      from,
      to,
      recorder,
    );

    // Each of these would reach PostgreSQL as a cast it cannot make, failing
    // the whole request rather than the one filter, if it were not caught.
    for (const cursor of [
      'nonsense',
      '2026-09-19T00:00:00.000Z|not-a-uuid',
      '2026-09-19T00:00:00.000Z|',
      'not-a-date|a45128c1-5946-41cc-bf3c-1d490520524b',
      "|'; DROP TABLE bank_sync_attempts; --",
    ])
      assert.equal(
        (await importRuns(db, { cursor })).runs.length,
        1,
        `cursor ${cursor} should have been ignored`,
      );
  } finally {
    await db.close();
  }
});

test('a request path is reduced to its shape, never its identifiers', () => {
  // These two carry a consent session and a provider account id. Neither may
  // reach a stored step, and the shape that remains is what explains a failure.
  assert.equal(sanitizePath('/sessions/abc123-secret'), '/sessions/…');
  assert.equal(
    sanitizePath('/accounts/4f2b9e/transactions?date_from=2026-09-01'),
    '/accounts/…/transactions',
  );
  assert.equal(
    sanitizePath('/accounts/4f2b9e/balances'),
    '/accounts/…/balances',
  );
  assert.equal(sanitizePath('/personal/client-info'), '/personal/client-info');
});

test('a refused request reaches the observer with its status and the wait the bank asked for', async () => {
  const seen: {
    path: string;
    status?: number;
    code?: string;
    retryAfterMs?: number;
  }[] = [];
  const ask = requester(
    'https://api.enablebanking.com',
    0,
    async () =>
      new Response('', { status: 429, headers: { 'retry-after': '600' } }),
    (event) => seen.push(event),
  );
  await assert.rejects(ask('/accounts/xyz/transactions', {}));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, 429);
  assert.equal(seen[0]!.code, 'rate_limit');
  assert.equal(seen[0]!.retryAfterMs, 600000);
  // The raw path reaches the observer; reducing it is the recorder's job.
  assert.equal(sanitizePath(seen[0]!.path), '/accounts/…/transactions');
});

test('a request that worked is reported too, not only the refusals', async () => {
  // The first version of this reported only failures, so a healthy run showed
  // no requests at all — and what was asked of the bank is most of what the
  // run screen exists to show. Caught on the first real import after release.
  const seen: {
    path: string;
    status?: number;
    size?: number;
    code?: string;
  }[] = [];
  const body = JSON.stringify({ accounts: [] });
  const ask = requester(
    'https://api.enablebanking.com',
    0,
    async () => new Response(body, { status: 200 }),
    (event) => seen.push(event),
  );
  await ask('/sessions/abc', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, 200);
  assert.equal(seen[0]!.size, Buffer.byteLength(body));
  assert.equal(seen[0]!.code, undefined);
});

test('a request that never got an answer is reported with no status', async () => {
  const seen: { path: string; status?: number; code?: string }[] = [];
  const ask = requester(
    'https://api.monobank.ua',
    0,
    async () => {
      throw new Error('socket hang up');
    },
    (event) => seen.push(event),
  );
  await assert.rejects(ask('/personal/client-info', {}));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, undefined);
  assert.equal(seen[0]!.code, 'transient');
});

test('an observer that throws cannot break an import', async () => {
  const ask = requester(
    'https://api.monobank.ua',
    0,
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => {
      throw new Error('the note failed');
    },
  );
  assert.deepEqual(await ask('/personal/client-info', {}), { ok: true });
});

test('the next attempt is recorded and reaches both the imports screen and the problems list', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');
    // A bank that has imported once and then been told to slow down.
    await syncBank(
      repo,
      connectorThat(async () => [ONE]),
      from,
      to,
    );
    await db.query(
      "UPDATE bank_sync_runs SET state='failed',error_code='rate_limit',last_success_at=now() - interval '27 hours'",
    );
    const next = new Date(Date.now() + 3 * 3600000);
    await recordNextAttempt(db, 'monobank:rodion', next, 'rate_limit');

    const status = await importStatus(db);
    const connection = status.connections.find(
      (c) => c.connection === 'monobank:rodion',
    );
    assert.equal(connection!.nextAttemptAt, next.toISOString());
    assert.equal(connection!.retryReason, 'rate_limit');

    // The health page must say when it resumes rather than only that it is
    // silent, which is what sent the owner looking for a fault that was not
    // there.
    const { problems } = await systemProblems(db, {});
    const entry = problems.find((problem) =>
      problem.id.startsWith('bank:monobank:rodion'),
    );
    assert.ok(entry, 'a bank silent for 27 hours is still reported');
    assert.match(entry!.detail, /next attempt/i);
    assert.equal(entry!.severity, 'warning');
    assert.match(entry!.title, /slow down/i);
  } finally {
    await db.close();
  }
});

test('the scheduler announces the wait it enforces, and keeps deferring without touching the bank', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-runs-schedule-'));
  const announced: { retryAfter: Date | null; reason: string | null }[] = [];
  let invocations = 0;
  const options = {
    instance: 'enablebanking-rodion-swedbank',
    now: new Date(),
    stateDirectory: directory,
    ready: async () => true,
    invoke: async () => {
      invocations++;
      return 'rate_limit' as const;
    },
    announce: async (retryAfter: Date | null, reason: string | null) => {
      announced.push({ retryAfter, reason });
    },
  };

  assert.equal(await runScheduledSync(options), 'rate_limit');
  assert.equal(invocations, 1);
  const set = announced.at(-1)!;
  assert.equal(set.reason, 'rate_limit');
  // Twelve hours, the value the owner chose.
  const waited = set.retryAfter!.getTime() - options.now.getTime();
  assert.ok(
    Math.abs(waited - 43200000) < 5000,
    `expected a twelve-hour wait, got ${waited} ms`,
  );

  // Every timer in between exits without asking the bank anything — and now
  // says so, instead of leaving the screen to guess from a stale failure.
  const later = { ...options, now: new Date(Date.now() + 3600000) };
  assert.equal(await runScheduledSync(later), 'deferred');
  assert.equal(invocations, 1, 'a deferred run must not reach the bank');
  assert.equal(announced.at(-1)!.reason, 'rate_limit');
  assert.equal(
    announced.at(-1)!.retryAfter!.getTime(),
    set.retryAfter!.getTime(),
  );

  // The reason is kept beside the time, so a restart does not lose why.
  assert.equal(
    (
      await readFile(
        join(directory, `${options.instance}.retry-reason`),
        'utf8',
      )
    ).trim(),
    'rate_limit',
  );
});

test('a wait set by an older release still reaches the screen, with no reason to give', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-runs-legacy-'));
  const instance = 'enablebanking-rodion-swedbank';
  const until = Date.now() + 7200000;
  // What the server actually held: a retry-after file and no reason beside it.
  await writeFile(join(directory, `${instance}.retry-after`), String(until));
  const announced: (string | null)[] = [];
  assert.equal(
    await runScheduledSync({
      instance,
      now: new Date(),
      stateDirectory: directory,
      ready: async () => true,
      invoke: async () => 'success' as const,
      announce: async (_retryAfter, reason) => {
        announced.push(reason);
      },
    }),
    'deferred',
  );
  assert.deepEqual(announced, [null]);
});

test('announcing cannot stop a bank from waiting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pf-runs-announce-fails-'));
  assert.equal(
    await runScheduledSync({
      instance: 'monobank-rodion',
      now: new Date(),
      stateDirectory: directory,
      ready: async () => true,
      invoke: async () => 'transient' as const,
      announce: async () => {
        throw new Error('the database is unreachable');
      },
    }),
    'transient',
  );
  // The cooldown was still written, which is the part that matters.
  const written = await readFile(
    join(directory, 'monobank-rodion.retry-after'),
    'utf8',
  );
  assert.ok(Number(written) > Date.now());
});

test('recording an attempt is never the reason an import fails', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const from = new Date('2026-09-01');
    const to = new Date('2026-09-02');
    // A recorder pointed at a database that refuses every write.
    const broken = {
      query: async () => {
        throw new Error('no');
      },
    } as never;
    const recorder = new AttemptRecorder(broken, 'monobank:rodion', from, to);
    await recorder.open();
    assert.deepEqual(
      await syncBank(
        repo,
        connectorThat(async () => [ONE]),
        from,
        to,
        recorder,
      ),
      { accounts: 1, changed: 1 },
    );
  } finally {
    await db.close();
  }
});
