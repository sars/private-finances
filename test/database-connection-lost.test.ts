import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresDatabase } from '../src/database.js';

// PGlite has no server to restart, so only real PostgreSQL can show this.
test(
  'a connection the server ends while idle does not take the process down',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = postgresDatabase(process.env.TEST_DATABASE_URL!);
    const admin = postgresDatabase(process.env.TEST_DATABASE_URL!);
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      // What a PostgreSQL restart does to every open connection: 57P01.
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      assert.notEqual(again, pid);
      assert.deepEqual(uncaught, []);
    } finally {
      process.removeListener('uncaughtException', record);
      await db.close();
      await admin.close();
    }
  },
);
