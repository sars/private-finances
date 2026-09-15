import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';

// `migrate` restores throwaway test databases from a per-process snapshot of an
// already migrated database. These tests pin the two properties that makes safe:
// every database is still independent, and a database that has already been
// touched is still migrated by the real migration code.
const payment = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'synthetic',
  sourceId: 'isolation',
  accountId: 'a',
  owner: 'rodion',
  bookedAt: '2026-09-12T10:00:00Z',
  currency: 'EUR',
  amountMinor: '-100',
  description: 'Isolation probe',
};

async function migrated() {
  const db = memoryDatabase();
  await migrate(db);
  return db;
}

test('a migrated database starts empty and accepts writes', async () => {
  const db = await migrated();
  try {
    assert.equal(
      (await db.query('SELECT * FROM transactions')).rows.length,
      0,
      'a fresh database must not carry rows from an earlier one',
    );
    await db.query(
      `INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        payment.id,
        payment.source,
        payment.sourceId,
        payment.accountId,
        payment.owner,
        payment.bookedAt,
        payment.currency,
        payment.amountMinor,
        payment.description,
      ],
    );
    assert.equal((await db.query('SELECT * FROM transactions')).rows.length, 1);
  } finally {
    await db.close();
  }
});

test('the next database sees none of the previous test rows', async () => {
  const db = await migrated();
  try {
    assert.deepEqual(
      (await db.query('SELECT id FROM transactions')).rows,
      [],
      'rows written by another test leaked into this database',
    );
    // Two databases alive at once must not share storage either.
    const other = await migrated();
    try {
      await db.query(
        `INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          payment.id,
          payment.source,
          payment.sourceId,
          payment.accountId,
          payment.owner,
          payment.bookedAt,
          payment.currency,
          payment.amountMinor,
          payment.description,
        ],
      );
      assert.deepEqual(
        (await other.query('SELECT id FROM transactions')).rows,
        [],
        'concurrent databases must not share storage',
      );
    } finally {
      await other.close();
    }
  } finally {
    await db.close();
  }
});

test('a snapshot never stands in for a real migration of a used database', async () => {
  const db = await migrated();
  try {
    await db.query('DROP TABLE app_settings_audit');
    await db.query('DROP TABLE app_settings');
    await db.query('DELETE FROM schema_versions WHERE version=17');
    await migrate(db);
    assert.equal(
      (await db.query('SELECT 1 FROM schema_versions WHERE version=17')).rows
        .length,
      1,
      'the real migration must rebuild a schema the test tore down',
    );
    assert.equal((await db.query('SELECT * FROM app_settings')).rows.length, 1);
    const versions = (
      await db.query<{ version: number }>(
        'SELECT version FROM schema_versions ORDER BY version',
      )
    ).rows.map((row) => Number(row.version));
    assert.ok(versions.length >= 18, 'every schema version must be recorded');
    assert.deepEqual(
      versions,
      Array.from({ length: versions.length }, (_, index) => index + 1),
      'a restored database must carry an unbroken version history',
    );
  } finally {
    await db.close();
  }
});
