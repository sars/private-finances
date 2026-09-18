import { useSyncExternalStore } from 'react';

/**
 * Keeping the installed app on the release the server is running.
 *
 * The app installs to a phone's home screen, and an installed app is resumed
 * far more often than it is started. iOS in particular keeps the same document
 * alive for days, so "reload the page" — the browser's own answer to a new
 * release — is a thing the household never does. Before this module the only
 * reliable way to get a new release onto the phone was to delete the app and
 * install it again.
 *
 * Three things had to be true, and each is one of the exports below.
 *
 * **The app has to notice.** `vite-plugin-pwa` registers the worker on the
 * document's `load` event and never again, and a resumed app fires no `load`.
 * So the check is driven from the app instead: on an interval while the app is
 * in the foreground, and whenever it comes back after long enough away to be
 * worth a round trip. `registration.update()` re-fetches `sw.js` and
 * `/health/live` reports the running release — two independent signals, because
 * a browser may hold a worker back under its own 24-hour update throttle long
 * after the release has plainly moved on.
 *
 * **Nothing may change under a screen in use.** The worker is built with
 * `registerType: 'prompt'`, so a new worker installs and then waits: the
 * document keeps the assets it started with until the household says go. The
 * alternative, `autoUpdate`, claims the page the moment the new worker
 * activates and drops the old precache with it — after which the next lazily
 * loaded screen asks for a hashed file the server no longer has and the
 * workspace shows its error card. That was the other half of why reinstalling
 * looked like the only way out.
 *
 * **A document that started before a release still has to survive.**
 * `recoverFromStaleBundle` handles what the prompt cannot: a page that was already open when the
 * release landed, reaching for a chunk that has since been replaced.
 */

/** Re-ask while the app is open. Long, because a release is a rare event. */
export const POLL_INTERVAL_MS = 30 * 60 * 1000;
/**
 * One recovery reload per window of this length. A release that genuinely
 * cannot load must show the error card rather than reload for ever, and a
 * release a fortnight later must still be allowed its own attempt.
 */
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const RECOVERY_KEY = 'pf-stale-bundle-reload';

let registration: ServiceWorkerRegistration | null = null;
/** The release the server reported while this document was loading. */
let loadedRelease: string | null = null;
let ready = false;
const listeners = new Set<() => void>();

function announce(): void {
  if (ready) return;
  ready = true;
  for (const listener of listeners) listener();
}

/**
 * True once a newer release is available — either a worker has finished
 * installing and is waiting, or the server is reporting a different release
 * than the one this document loaded against.
 */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ready,
    () => false,
  );
}

/**
 * The release this document belongs to. Taken from the first `/api/bootstrap`
 * of the session, which the shell fetches before it can draw anything, and
 * never replaced: it is the baseline every later check is compared against.
 */
export function noteLoadedRelease(release: string | undefined): void {
  if (!loadedRelease && release) loadedRelease = release;
}

function watch(target: ServiceWorkerRegistration): void {
  // A worker that finished installing while the app was in the background is
  // already sitting in `waiting` by the time anything here runs.
  if (target.waiting && navigator.serviceWorker.controller) announce();
  target.addEventListener('updatefound', () => {
    const installing = target.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // With no controller this is the first install on this device, which is
      // not an update and must not put a prompt in front of anyone.
      if (
        installing.state === 'installed' &&
        navigator.serviceWorker.controller
      )
        announce();
    });
  });
}

/**
 * Registers the worker and starts watching for a newer release. Safe to call
 * more than once; only the first call does anything.
 */
export function startUpdateWatch(): void {
  if (registration || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((created) => {
      registration = created;
      watch(created);
    })
    .catch(() => {
      // An install can fail for reasons the household cannot act on — a
      // private window, a policy, a transient 503 during a release. The app
      // works without a worker; it only loses offline start-up.
    });
}

async function runningRelease(): Promise<string | null> {
  try {
    const response = await fetch('/health/live', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { release?: unknown };
    return typeof body.release === 'string' ? body.release : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server and the worker whether this document is still current, and
 * report whether a newer release is now waiting. The answer is what the manual
 * "Check for updates" button reads to tell the household either way.
 */
export async function checkForUpdate(): Promise<boolean> {
  if (ready) return true;
  try {
    await registration?.update();
  } catch {
    // Offline, or the browser declined to check. The release probe below is
    // the other half of the answer.
  }
  const current = await runningRelease();
  if (current && loadedRelease && current !== loadedRelease) announce();
  // An installing worker reaches `waiting` a moment after `update()` resolves,
  // and `watch` announces it then; this only reports what is known now.
  return ready;
}

/**
 * Hands the page over to the new release. The waiting worker is told to take
 * over and the reload happens once it has; with no worker involved — the
 * release moved but the worker has not caught up — a plain reload is enough,
 * because the shell is never cached and always comes from the server.
 */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => window.location.reload(),
    { once: true },
  );
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // If the worker was already past the point where it listens, no
  // controllerchange ever arrives. Reloading regardless costs a few seconds.
  window.setTimeout(() => window.location.reload(), 3000);
}

/**
 * Is this the failure of a document that outlived its own build? Every screen
 * past the first is a lazy import of a hashed file, and a release removes the
 * files it replaced, so a page left open across one fails the moment it opens
 * a screen it had not opened before.
 */
export function isStaleBundleError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(
    message,
  );
}

/** Whether a recovery reload has already been spent inside the window. */
export function recoveryAvailable(now: number, stamp: string | null): boolean {
  if (!stamp) return true;
  const at = Number(stamp);
  return !Number.isFinite(at) || now - at > RECOVERY_WINDOW_MS;
}

/**
 * Reloads once to pick up the current build, and reports whether it did. The
 * shell is never cached, so the reload always lands on the current release.
 */
export function recoverFromStaleBundle(error: unknown): boolean {
  if (!isStaleBundleError(error)) return false;
  const now = Date.now();
  try {
    if (!recoveryAvailable(now, sessionStorage.getItem(RECOVERY_KEY)))
      return false;
    sessionStorage.setItem(RECOVERY_KEY, String(now));
  } catch {
    // Storage is unavailable, in a private window or under a strict policy.
    // One reload without the guard still beats a dead screen.
  }
  window.location.reload();
  return true;
}
