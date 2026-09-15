import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';

test('existing version 15 databases gain the question snapshot without losing history', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query('DELETE FROM schema_versions WHERE version=16');
    await db.query('ALTER TABLE telegram_outbox DROP COLUMN payment_snapshot');
    await db.query('INSERT INTO telegram_updates(update_id) VALUES(12345)');
    await migrate(db);
    await migrate(db);
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='telegram_outbox' AND column_name='payment_snapshot'",
    );
    assert.equal(columns.rows.length, 1);
    assert.equal(
      (await db.query('SELECT 1 FROM schema_versions WHERE version=16')).rows
        .length,
      1,
    );
    assert.equal(
      (await db.query('SELECT 1 FROM telegram_updates WHERE update_id=12345'))
        .rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
