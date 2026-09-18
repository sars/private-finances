import assert from 'node:assert/strict';
import test from 'node:test';
import {
  memoryDatabase,
  migrate,
  retirePerOwnerBankConnections,
} from '../src/database.js';

/**
 * Before banks were scheduled separately every Enable Banking import of an
 * owner leased one key, `enablebanking:<owner>`. The per-bank split left that
 * row in place so its import windows kept a parent, and it went on being
 * listed as a connection of its own long after it stopped importing anything.
 */
test('a per-owner bank connection hands its windows to the bank that owns them', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO bank_sync_runs(connection,state) VALUES
       ('enablebanking:rodion','succeeded'),
       ('enablebanking:rodion:wise','succeeded'),
       ('enablebanking:rodion:revolut','succeeded'),
       ('monobank:rodion','succeeded')`,
    );
    await db.query(
      `INSERT INTO bank_import_windows(id,connection,account_id,owner,currency,from_at,to_at,changed)
       VALUES
       (gen_random_uuid(),'enablebanking:rodion','acct-wise-eur','rodion','EUR',now() - interval '30 days',now() - interval '1 day',1),
       (gen_random_uuid(),'enablebanking:rodion','acct-rev-usd','rodion','USD',now() - interval '30 days',now() - interval '1 day',3),
       (gen_random_uuid(),'enablebanking:rodion:wise','acct-wise-eur','rodion','EUR',now() - interval '1 day',now(),0),
       (gen_random_uuid(),'enablebanking:rodion:revolut','acct-rev-usd','rodion','USD',now() - interval '1 day',now(),0),
       (gen_random_uuid(),'monobank:rodion','acct-mono','rodion','UAH',now() - interval '1 day',now(),0)`,
    );

    const first = await db.transaction((tx) =>
      retirePerOwnerBankConnections(tx),
    );
    assert.deepEqual(first, { moved: 2, removed: 1 });

    const windows = new Map(
      (
        await db.query(
          'SELECT account_id, connection FROM bank_import_windows ORDER BY account_id, connection',
        )
      ).rows.map((r) => [String(r.account_id), String(r.connection)]),
    );
    assert.equal(windows.get('acct-wise-eur'), 'enablebanking:rodion:wise');
    assert.equal(windows.get('acct-rev-usd'), 'enablebanking:rodion:revolut');
    assert.equal(
      windows.get('acct-mono'),
      'monobank:rodion',
      'a Monobank key has no bank segment and must not be read as a leftover',
    );

    const connections = (
      await db.query(
        'SELECT connection FROM bank_sync_runs ORDER BY connection',
      )
    ).rows.map((r) => String(r.connection));
    assert.deepEqual(connections, [
      'enablebanking:rodion:revolut',
      'enablebanking:rodion:wise',
      'monobank:rodion',
    ]);

    // Nothing was thrown away: every window still exists, under a live parent.
    const total = await db.query(
      'SELECT count(*)::int AS n FROM bank_import_windows',
    );
    assert.equal(Number(total.rows[0]!.n), 5);

    const again = await db.transaction((tx) =>
      retirePerOwnerBankConnections(tx),
    );
    assert.deepEqual(again, { moved: 0, removed: 0 }, 'a re-run is a no-op');
  } finally {
    await db.close();
  }
});

/**
 * An account that only ever imported under the per-owner key has no bank to
 * recover. Guessing one would be worse than leaving it, so the windows stay
 * and the row keeps them — still labelled, still visible, still true.
 */
test('a per-owner connection with nowhere to send its windows is kept', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO bank_sync_runs(connection,state) VALUES
       ('enablebanking:katya','succeeded'),('enablebanking:katya:wise','succeeded')`,
    );
    await db.query(
      `INSERT INTO bank_import_windows(id,connection,account_id,owner,currency,from_at,to_at,changed)
       VALUES
       (gen_random_uuid(),'enablebanking:katya','acct-closed','katya','EUR',now() - interval '30 days',now() - interval '1 day',7),
       (gen_random_uuid(),'enablebanking:katya:wise','acct-open','katya','EUR',now() - interval '1 day',now(),0)`,
    );

    const result = await db.transaction((tx) =>
      retirePerOwnerBankConnections(tx),
    );
    assert.deepEqual(result, { moved: 0, removed: 0 });

    const kept = await db.query(
      "SELECT connection FROM bank_import_windows WHERE account_id='acct-closed'",
    );
    assert.equal(String(kept.rows[0]!.connection), 'enablebanking:katya');
    const parent = await db.query(
      "SELECT connection FROM bank_sync_runs WHERE connection='enablebanking:katya'",
    );
    assert.equal(parent.rows.length, 1, 'its windows still need a parent');
  } finally {
    await db.close();
  }
});
