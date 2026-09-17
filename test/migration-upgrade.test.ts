import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate, type Database } from '../src/database.js';

/**
 * Rebuilds the situation a deployed database is actually in: fully migrated, but
 * without the receipt evidence upgrade. Receipt deletion, Telegram feedback and
 * duplicate detection were first written inside initializeReceipts, which only
 * runs in the one-time schema version 15 block. Every deployed database therefore
 * skipped them, while every test passed because tests always build a schema from
 * scratch. These tests fail if that mistake returns.
 */
async function databaseWithoutReceiptUpgrade(): Promise<Database> {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `ALTER TABLE receipt_jobs DROP COLUMN feedback_state, DROP COLUMN feedback_attempts,
     DROP COLUMN feedback_after, DROP COLUMN image_sha256, DROP COLUMN duplicate_of,
     DROP COLUMN settlement_difference`,
  );
  await db.query(
    'ALTER TABLE receipt_jobs DROP CONSTRAINT receipt_jobs_state_check',
  );
  await db.query(
    "ALTER TABLE receipt_jobs ADD CONSTRAINT receipt_jobs_state_check CHECK(state IN ('queued','processing','matched','pending','not_receipt','failed'))",
  );
  await db.query('DELETE FROM schema_versions WHERE version IN (19,20)');
  return db;
}
/**
 * The next deployed shape: everything through version 19, but no recorded
 * settlement difference. Adding that column inside initializeReceipts alone would
 * repeat exactly the mistake above, so it has its own version block.
 */
async function databaseWithoutSettlementDifference(): Promise<Database> {
  const db = memoryDatabase();
  await migrate(db);
  await db.query('ALTER TABLE receipt_jobs DROP COLUMN settlement_difference');
  await db.query('DELETE FROM schema_versions WHERE version=20');
  return db;
}
/**
 * The shape every database is in before PDF receipts exist: fully migrated
 * through version 20, but with no preview columns. Adding them inside
 * initializeReceipts alone would repeat the same mistake a third time, so they
 * have their own version block.
 */
async function databaseWithoutReceiptPreview(): Promise<Database> {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    'ALTER TABLE receipt_jobs DROP COLUMN preview_image, DROP COLUMN preview_mime',
  );
  await db.query('DELETE FROM schema_versions WHERE version=21');
  return db;
}
const columns = async (db: Database) =>
  (
    await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='receipt_jobs'
       AND column_name IN ('feedback_state','feedback_attempts','feedback_after','image_sha256','duplicate_of','settlement_difference')
       ORDER BY column_name`,
    )
  ).rows.map((r) => String(r.column_name));

test('an already-migrated database receives the receipt evidence upgrade', async () => {
  const db = await databaseWithoutReceiptUpgrade();
  try {
    // A receipt that predates the upgrade, exactly like the ones in production.
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state)
       VALUES('00000000-0000-4000-8000-0000000000a1','rodion','-10',1,'f1','pending')`,
    );
    assert.deepEqual(await columns(db), []);
    await migrate(db);
    assert.deepEqual(await columns(db), [
      'duplicate_of',
      'feedback_after',
      'feedback_attempts',
      'feedback_state',
      'image_sha256',
      'settlement_difference',
    ]);
    assert.equal(
      (await db.query('SELECT version FROM schema_versions WHERE version=19'))
        .rows.length,
      1,
    );
    // The widened constraint must accept both new states and still reject others.
    await db.query(
      "UPDATE receipt_jobs SET state='deleted' WHERE message_id=1",
    );
    await db.query(
      "UPDATE receipt_jobs SET state='duplicate' WHERE message_id=1",
    );
    await assert.rejects(
      db.query("UPDATE receipt_jobs SET state='bogus' WHERE message_id=1"),
      /receipt_jobs_state_check/,
    );
  } finally {
    await db.close();
  }
});

test('the upgrade acknowledges pre-existing receipts so none are notified retroactively', async () => {
  const db = await databaseWithoutReceiptUpgrade();
  try {
    for (const [id, message, state] of [
      ['a1', 1, 'pending'],
      ['a2', 2, 'matched'],
      ['a3', 3, 'queued'],
    ] as const)
      await db.query(
        `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state)
         VALUES($1,'rodion','-10',$2,'f','${state}')`,
        [`00000000-0000-4000-8000-0000000000${id}`, message],
      );
    await migrate(db);
    const rows = (
      await db.query(
        'SELECT state,feedback_state,feedback_attempts FROM receipt_jobs ORDER BY message_id',
      )
    ).rows;
    // Resolved receipts are marked as already answered; a queued one is not,
    // because it has no outcome to report yet.
    assert.equal(rows[0]?.feedback_state, 'pending');
    assert.equal(rows[1]?.feedback_state, 'matched');
    assert.equal(rows[2]?.feedback_state, null);
    assert.equal(Number(rows[0]?.feedback_attempts), 0);
  } finally {
    await db.close();
  }
});

test('re-running migrate on an upgraded database changes nothing', async () => {
  const db = await databaseWithoutReceiptUpgrade();
  try {
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state)
       VALUES('00000000-0000-4000-8000-0000000000b1','rodion','-10',1,'f1','pending')`,
    );
    await migrate(db);
    // Simulate feedback already delivered, then restart twice.
    await db.query(
      "UPDATE receipt_jobs SET feedback_state='matched',state='matched' WHERE message_id=1",
    );
    const snapshot = async () =>
      (
        await db.query(
          'SELECT state,feedback_state,feedback_attempts FROM receipt_jobs ORDER BY message_id',
        )
      ).rows;
    const before = await snapshot();
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM schema_versions WHERE version=19',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('an already-migrated database gains the settlement difference column', async () => {
  const db = await databaseWithoutSettlementDifference();
  try {
    // A receipt linked before the upgrade, exactly like the ones in production.
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,feedback_state)
       VALUES('00000000-0000-4000-8000-0000000000d1','rodion','-10',1,'f1','matched','matched')`,
    );
    const column = async () =>
      (
        await db.query(
          `SELECT data_type FROM information_schema.columns
           WHERE table_name='receipt_jobs' AND column_name='settlement_difference'`,
        )
      ).rows.map((r) => String(r.data_type));
    assert.deepEqual(await column(), []);
    await migrate(db);
    assert.deepEqual(await column(), ['jsonb']);
    assert.equal(
      (await db.query('SELECT version FROM schema_versions WHERE version=20'))
        .rows.length,
      1,
    );
    // No backfill: an existing row cannot carry a difference nobody detected.
    const snapshot = async () =>
      (
        await db.query(
          'SELECT state,feedback_state,settlement_difference FROM receipt_jobs ORDER BY message_id',
        )
      ).rows;
    assert.deepEqual(await snapshot(), [
      {
        state: 'matched',
        feedback_state: 'matched',
        settlement_difference: null,
      },
    ]);
    const before = await snapshot();
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await column(), ['jsonb']);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM schema_versions WHERE version=20',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('an already-migrated database gains the receipt preview columns', async () => {
  const db = await databaseWithoutReceiptPreview();
  try {
    // A photo receipt stored before PDFs existed, exactly like production has.
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,mime,image,feedback_state)
       VALUES('00000000-0000-4000-8000-0000000000e1','rodion','-10',1,'f1','matched','image/jpeg',
       decode('ffd8ff07','hex'),'matched')`,
    );
    const preview = async () =>
      (
        await db.query(
          `SELECT column_name,data_type FROM information_schema.columns
           WHERE table_name='receipt_jobs' AND column_name IN ('preview_image','preview_mime')
           ORDER BY column_name`,
        )
      ).rows.map((r) => `${String(r.column_name)}:${String(r.data_type)}`);
    assert.deepEqual(await preview(), []);
    await migrate(db);
    assert.deepEqual(await preview(), [
      'preview_image:bytea',
      'preview_mime:text',
    ]);
    assert.equal(
      (await db.query('SELECT version FROM schema_versions WHERE version=21'))
        .rows.length,
      1,
    );
    // No backfill: an existing photo is already its own preview, and image()
    // falls back to the stored image when no preview exists.
    const snapshot = async () =>
      (
        await db.query(
          `SELECT state,mime,preview_image,preview_mime,encode(image,'hex') AS image
           FROM receipt_jobs ORDER BY message_id`,
        )
      ).rows;
    assert.deepEqual(await snapshot(), [
      {
        state: 'matched',
        mime: 'image/jpeg',
        preview_image: null,
        preview_mime: null,
        image: 'ffd8ff07',
      },
    ]);
    const before = await snapshot();
    // Re-running changes nothing and never applies version 21 twice.
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await preview(), [
      'preview_image:bytea',
      'preview_mime:text',
    ]);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM schema_versions WHERE version=21',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

/**
 * The same mistake once more, and the reason this file exists. The column the
 * bot needs to react to and answer the owner's message was first added inside
 * `initializeTelegram`, which only runs in the one-time schema version 7 block.
 * Every deployed database therefore skipped it while every test passed, because
 * tests build a schema from scratch. It has its own version block now.
 */
async function databaseWithoutTelegramMessageId(): Promise<Database> {
  const db = memoryDatabase();
  await migrate(db);
  await db.query('ALTER TABLE telegram_proposal_inputs DROP COLUMN message_id');
  await db.query('DELETE FROM schema_versions WHERE version=34');
  return db;
}

test('an already deployed database gains the column that says who explained a payment', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      'ALTER TABLE transaction_explanations DROP COLUMN answered_by',
    );
    await db.query('DELETE FROM schema_versions WHERE version=47');
    const column = async () =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name='transaction_explanations' AND column_name='answered_by'`,
        )
      ).rows.length;
    assert.equal(await column(), 0);
    await migrate(db);
    assert.equal(await column(), 1);
    // Migrating again is a no-op rather than an error.
    await migrate(db);
    assert.equal(await column(), 1);
  } finally {
    await db.close();
  }
});

test('an already deployed database gains the column that records the owner’s message', async () => {
  const db = await databaseWithoutTelegramMessageId();
  try {
    const column = async () =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name='telegram_proposal_inputs' AND column_name='message_id'`,
        )
      ).rows.length;
    assert.equal(await column(), 0);
    await migrate(db);
    assert.equal(await column(), 1);
    // Migrating again is a no-op rather than an error.
    await migrate(db);
    assert.equal(await column(), 1);
  } finally {
    await db.close();
  }
});
