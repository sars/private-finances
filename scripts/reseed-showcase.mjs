// Refills the showcase and puts it back on the current release.
//
// Run by `private-finances-showcase-reseed.service`, which a `.path` unit
// starts when the reseed page leaves a request file. Not meant to be run by
// hand — though it can be, and says what it is doing if it is.
//
// It runs as root, because it stops and starts a service, and drops to the
// `private-finances` user for the seeding itself so the database files end up
// owned by the account that has to read them. Everything it does is recorded
// in the status file the page polls, including the failures: a reseed that
// died silently is how the demo came to be four months stale without anybody
// noticing.
//
// Stopping the service is not incidental. PGlite allows one process per data
// directory, so a workspace cannot be rebuilt underneath a server holding it;
// and `WorkingDirectory=/opt/private-finances/current` is resolved once at
// start, so stopping and starting is also the only thing that moves the demo
// onto a release that has been switched since it booted.
import { spawn } from 'node:child_process';
import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readReseedRequest,
  requestPath,
  writeReseedStatus,
} from '../dist/src/showcase-control.js';

const directory =
  process.env.SHOWCASE_CONTROL_DIR ?? '/var/lib/private-finances-showcase';
const dataDirectory = process.env.DEMO_DATA_DIR ?? join(directory, 'demo');
const unit = process.env.SHOWCASE_UNIT ?? 'private-finances-showcase';
const account = process.env.SHOWCASE_USER ?? 'private-finances';
// Empty means "seed in this process's own account", which is what a laptop
// wants; on the server the seeding has to land as `private-finances`.
const dropPrivileges = process.env.SHOWCASE_DROP_PRIVILEGES !== 'no';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              // The last line of stderr, because a stack trace in a status
              // file read on a phone is worse than useless.
              err.trim().split('\n').filter(Boolean).pop() ??
                `${command} exited ${code}`,
            ),
          ),
    );
  });
}

const systemctl = (...args) => run('systemctl', args);

const request = await readReseedRequest(directory);
if (!request) {
  console.error(`no reseed request in ${directory}; nothing to do`);
  process.exit(0);
}
const { shape, requestedAt } = request;

// Taken before the work starts, so a second press while this one runs does not
// queue a third: the path unit fires on the file appearing, and the file is
// gone by the time anything else looks.
await unlink(requestPath(directory)).catch(() => {});

// Which release the demo will come back on. The deploy names a release
// directory after its commit, and `current` is the symlink the switch flips,
// so resolving it is the whole answer. Worth recording: a reseed is also how
// the demo moves between releases, and the page says which one it landed on.
const release = await run('readlink', ['-f', '/opt/private-finances/current'])
  .then((value) => value.trim().split('/').pop() ?? '')
  .catch(() => '');

const status = {
  state: 'seeding',
  requestedAt,
  shape,
  release: release || undefined,
};
await writeReseedStatus(directory, status);

try {
  await systemctl('stop', unit);

  // A fresh directory rather than a reused one. The seeder can refill a
  // workspace in place and is tested doing it, but a reseed that failed part
  // way leaves one holding two households, and starting from nothing is the
  // one thing that cannot inherit that. It costs the initdb, which is seconds.
  await rm(dataDirectory, { recursive: true, force: true });

  const environment = {
    ...process.env,
    DEMO_DATA_DIR: dataDirectory,
    APP_MODE: 'demo',
    SHOWCASE_DENSITY: String(shape.density),
    SHOWCASE_MONTHS: String(shape.months),
    SHOWCASE_REFUNDS: String(shape.refunds),
    SHOWCASE_RECEIPTS: String(shape.receipts),
  };
  // `DATABASE_URL` in the environment makes the seeder refuse to start at all,
  // and a unit that inherited one from somewhere would be a poor way to find
  // that out. Dropped rather than trusted.
  delete environment.DATABASE_URL;

  const seeder = 'scripts/seed-showcase.mjs';
  const output = dropPrivileges
    ? await run('runuser', ['-u', account, '--', process.execPath, seeder], {
        cwd: '/opt/private-finances/current',
        env: environment,
      })
    : await run(process.execPath, [seeder], { env: environment });

  // The seeder prints one line of counts; parsing it keeps the numbers in one
  // place rather than having two scripts agree on a format.
  const counts = {};
  for (const [, value, name] of output.matchAll(
    /(\d+)\s+(payments|accounts|holdings|snapshots|daily rates|linked refunds|receipts)/g,
  )) {
    const key = {
      payments: 'transactions',
      accounts: 'accounts',
      holdings: 'holdings',
      snapshots: 'snapshots',
      'daily rates': 'rates',
      'linked refunds': 'refunds',
      receipts: 'receipts',
    }[name];
    if (key) counts[key] = Number(value);
  }

  await writeReseedStatus(directory, { ...status, state: 'starting', counts });
  await systemctl('start', unit);
  await writeReseedStatus(directory, {
    ...status,
    state: 'done',
    counts,
    finishedAt: new Date().toISOString(),
  });
  console.log(`showcase refilled and restarted: ${JSON.stringify(counts)}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeReseedStatus(directory, {
    ...status,
    state: 'failed',
    error: message,
    finishedAt: new Date().toISOString(),
  });
  // Start it again regardless. A demo showing an empty or half-built workspace
  // is worth more than a demo that is simply not there: the first can be
  // recognised and refilled, the second looks like the server is broken.
  await systemctl('start', unit).catch(() => {});
  console.error(`showcase refill failed: ${message}`);
  process.exit(1);
}
