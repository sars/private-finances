import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STORAGE_CRITICAL_BYTES,
  STORAGE_TIGHT_BYTES,
  storageDetail,
  storageState,
} from '../src/storage-health.js';
import { readStorage } from '../src/storage.js';

const GB = 1024 ** 3;

test('the disk is judged by what is left, not by the percentage used', () => {
  // A 96 GB disk at 85% has 14 GB free and a fortnight of room; a 200 GB disk
  // at the same 85% has 30 GB. The percentage is what gets shown, but it is not
  // what decides, because the thing being asked is whether the next releases
  // and dumps will fit.
  assert.equal(storageState(40 * GB), 'ample');
  assert.equal(storageState(14 * GB), 'tight');
  assert.equal(storageState(2 * GB), 'critical');
  assert.equal(storageState(0), 'critical');
});

test('the thresholds are exclusive at the boundary', () => {
  assert.equal(storageState(STORAGE_CRITICAL_BYTES), 'tight');
  assert.equal(storageState(STORAGE_CRITICAL_BYTES - 1), 'critical');
  assert.equal(storageState(STORAGE_TIGHT_BYTES), 'ample');
  assert.equal(storageState(STORAGE_TIGHT_BYTES - 1), 'tight');
});

test('the detail line is whole gigabytes and nothing else', () => {
  assert.equal(
    storageDetail({
      totalBytes: 96 * GB,
      availableBytes: 49 * GB,
      usedRatio: 0.5,
      state: 'ample',
    }),
    '49 GB free of 96 GB',
  );
});

test('reading the filesystem gives a usable figure, and never throws', async () => {
  const storage = await readStorage();
  assert.ok(storage, 'the filesystem this test runs on should answer');
  assert.ok(storage.totalBytes > 0);
  assert.ok(storage.availableBytes >= 0);
  assert.ok(storage.availableBytes <= storage.totalBytes);
  assert.ok(storage.usedRatio >= 0 && storage.usedRatio <= 1);
  assert.equal(storage.state, storageState(storage.availableBytes));
});

test('a path that cannot be read is reported as no reading, not as a failure', async () => {
  // The operations page asks for this beside the backup and the bank
  // connections. A disk that will not answer must cost the card, not the page.
  assert.equal(
    await readStorage('/definitely-not-a-path-on-this-machine'),
    null,
  );
});
