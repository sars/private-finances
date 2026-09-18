import test from 'node:test';
import assert from 'node:assert/strict';
// Vite replaces dist/frontend; use Node's type stripping for the pure helpers.
const { isStaleBundleError, recoveryAvailable } = await import(
  new URL('../../frontend/src/lib/app-update.ts', import.meta.url).href
);

test('a document that outlived its release is recognised and reloaded once', () => {
  // The wording differs by engine, and every one of these is the same event:
  // a screen the app had not opened before asking for a hashed file that the
  // release replaced. Chrome, Firefox and Safari in turn.
  for (const message of [
    'Failed to fetch dynamically imported module: https://example.test/assets/Review-BJHDKG9c.js',
    'error loading dynamically imported module: /assets/Assets-C4A5xAQd.js',
    'Importing a module script failed.',
  ])
    assert.equal(isStaleBundleError(new Error(message)), true);

  // A fault inside a screen is the workspace's own to report; reloading would
  // hide a real defect behind a flash and could repeat for ever.
  for (const message of [
    'Cannot read properties of undefined (reading "amount")',
    'Could not load this view (503). Please retry.',
    'NetworkError when attempting to fetch resource.',
  ])
    assert.equal(isStaleBundleError(new Error(message)), false);
  assert.equal(isStaleBundleError(undefined), false);

  // One reload per ten minutes: a build that genuinely cannot load shows the
  // error card instead of circling, and the release after it still gets a try.
  const now = 1_800_000_000_000;
  assert.equal(recoveryAvailable(now, null), true);
  assert.equal(recoveryAvailable(now, String(now - 1_000)), false);
  assert.equal(recoveryAvailable(now, String(now - 9 * 60_000)), false);
  assert.equal(recoveryAvailable(now, String(now - 11 * 60_000)), true);
  // A value the app did not write, left by something else under the same key.
  assert.equal(recoveryAvailable(now, 'not-a-timestamp'), true);
});
