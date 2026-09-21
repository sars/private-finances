/**
 * How the reseed page asks for a reseed, and how it learns what happened.
 *
 * The demo cannot reseed itself. PGlite allows one process per data directory
 * and the running service is holding it, so a workspace can only be refilled
 * while the service is stopped — and stopping it is also the only way the demo
 * ever moves onto a newer release, because `WorkingDirectory` is resolved once
 * at start and a release switch flips the symlink underneath a process that
 * already resolved it. Both of those need root, and the demo has none: it is a
 * service with no login, reachable by anyone on the tailnet, and giving it the
 * power to run `systemctl` would be a poor trade for the convenience.
 *
 * So the page writes a file and stops. A systemd path unit notices the file
 * and starts a root oneshot, which stops the service, seeds outside its cgroup
 * and starts it again, writing what happened into the status file as it goes.
 * The privileged work lives in a unit anyone can read, and the only authority
 * the demo holds is the authority to leave a note.
 *
 * Both files sit beside the demo's data directory rather than inside it: the
 * data directory belongs to PGlite, and on the server it is also the thing
 * being rebuilt.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What a reseed was asked to build. Clamped by the seeder, not here. */
export type ShowcaseShapeRequest = {
  density: number;
  months: number;
  refunds: number;
  receipts: number;
};

export type ShowcaseReseedRequest = {
  requestedAt: string;
  shape: ShowcaseShapeRequest;
};

/**
 * Where a reseed has got to.
 *
 * `seeding` and `starting` both mean the demo is down — it is stopped for the
 * whole of the seeding, which takes a few minutes — so the page has to be able
 * to show them from a browser that can no longer reach the server. It does
 * that by having loaded already and polling; see the status script on the page.
 */
export type ShowcaseReseedStatus = {
  state: 'queued' | 'seeding' | 'starting' | 'done' | 'failed';
  requestedAt: string;
  finishedAt?: string;
  shape?: ShowcaseShapeRequest;
  counts?: Record<string, number>;
  /** The release the demo is running now, which a reseed is also how it moves. */
  release?: string;
  /** Why it failed, in words rather than as a stack. */
  error?: string;
};

export const requestPath = (directory: string): string =>
  join(directory, 'reseed.request');
export const statusPath = (directory: string): string =>
  join(directory, 'reseed.status.json');

/** The directory the two files live in, given where the demo keeps its data. */
export const controlDirectory = (dataDirectory: string): string =>
  dirname(dataDirectory);

/**
 * Write a file in one step, so a reader never sees half of it.
 *
 * The path unit fires on the request file appearing and the page polls the
 * status file, both while the other side is writing; a rename within the same
 * directory is atomic and a partial write is not.
 */
async function atomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.partial`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

export async function writeReseedRequest(
  directory: string,
  shape: ShowcaseShapeRequest,
): Promise<ShowcaseReseedRequest> {
  const request: ShowcaseReseedRequest = {
    requestedAt: new Date().toISOString(),
    shape,
  };
  // The status goes first and says `queued`, so that a page reloaded in the
  // seconds before the unit starts shows the reseed it just asked for rather
  // than the one before it.
  await writeReseedStatus(directory, {
    state: 'queued',
    requestedAt: request.requestedAt,
    shape,
  });
  await atomically(requestPath(directory), JSON.stringify(request));
  return request;
}

export async function writeReseedStatus(
  directory: string,
  status: ShowcaseReseedStatus,
): Promise<void> {
  await atomically(statusPath(directory), JSON.stringify(status));
}

/**
 * The last reseed, or null when none has been asked for.
 *
 * Unreadable and unparseable both answer null. A status file is a convenience
 * — the workspace itself is the record of what was seeded — so a page that
 * cannot read one should offer the form rather than an error.
 */
export async function readReseedStatus(
  directory: string,
): Promise<ShowcaseReseedStatus | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(statusPath(directory), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const status = parsed as ShowcaseReseedStatus;
    return typeof status.state === 'string' ? status : null;
  } catch {
    return null;
  }
}

export async function readReseedRequest(
  directory: string,
): Promise<ShowcaseReseedRequest | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(requestPath(directory), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const request = parsed as ShowcaseReseedRequest;
    return request.shape && typeof request.shape === 'object' ? request : null;
  } catch {
    return null;
  }
}
