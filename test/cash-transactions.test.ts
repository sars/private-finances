import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate, type Database } from '../src/database.js';
import { CashTransactions } from '../src/cash-transactions.js';
import { Accounts } from '../src/accounts.js';
import { Repository } from '../src/repository.js';
import { expenseSummary } from '../src/domain.js';
import { convertedSpending } from '../src/analytics.js';

const input = () => ({
  requestId: randomUUID(),
  amount: '12.34',
  currency: 'EUR',
  date: '2026-09-12',
  description: 'Cash lunch',
});
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  return { db, cash: new CashTransactions(db), repo: new Repository(db) };
}
test('cash purchase is atomic, exact and idempotent with separate owner accounts and request scopes', async () => {
  const { db, cash, repo } = await setup();
  try {
    const value = input();
    const results = await Promise.all([
      cash.create('rodion', value),
      cash.create('rodion', value),
    ]);
    assert.equal(results[0]!.id, results[1]!.id);
    assert.equal(results.filter((row) => row.created).length, 1);
    const other = await cash.create('katya', value);
    assert.notEqual(other.id, results[0]!.id);
    const rows = await repo.list('rodion');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amountMinor, '-1234');
    assert.equal(rows[0]!.kind, 'unresolved');
    assert.equal(rows[0]!.status, 'booked');
    assert.equal(rows[0]!.bookedAt, '2026-09-12T09:00:00.000Z');
    assert.equal(
      (await new Accounts(db).list('rodion'))[0]!.purpose,
      'personal',
    );
    assert.equal(
      (await db.query('SELECT * FROM account_audit_events')).rows.length,
      2,
    );
    assert.equal((await db.query('SELECT * FROM audit_events')).rows.length, 2);
    for (const patch of [
      { amount: '12.35' },
      { currency: 'USD' },
      { date: '2026-09-13' },
      { description: 'Changed' },
    ]) {
      await assert.rejects(
        cash.create('rodion', { ...value, ...patch }),
        /cash_request_conflict/,
      );
    }
    assert.equal((await repo.list('rodion')).length, 1);
    assert.equal((await repo.list('katya')).length, 1);
  } finally {
    await db.close();
  }
});
test('cash validation refuses numeric floats, precision loss, empty context and invalid actors or dates', async () => {
  const { db, cash, repo } = await setup();
  try {
    for (const patch of [
      { amount: 12.34 },
      { amount: '1e2' },
      { amount: '-1' },
      { amount: '0' },
      { amount: '01' },
      { amount: '1.234' },
      { amount: '1.0', currency: 'JPY' },
      { amount: '1.2345', currency: 'KWD' },
      { currency: 'ZZZ' },
      { date: '2026-02-30' },
      { date: 'bad' },
      { description: '  ' },
      { requestId: 'bad' },
    ]) {
      await assert.rejects(
        cash.create('rodion', { ...input(), ...patch }),
        /cash_invalid_/,
      );
    }
    await assert.rejects(
      cash.create('outsider' as 'rodion', input()),
      /cash_invalid_actor/,
    );
    for (const [currency, amount, expected] of [
      ['JPY', '123', '-123'],
      ['KWD', '1.234', '-1234'],
      ['EUR', '90071992547409.93', '-9007199254740993'],
    ]) {
      const result = await cash.create('rodion', {
        ...input(),
        currency,
        amount,
        date: '2026-01-12',
      });
      const row = (await repo.list('rodion')).find(
        (row) => row.id === result.id,
      )!;
      assert.equal(row.amountMinor, expected);
      assert.equal(row.bookedAt, '2026-01-12T10:00:00.000Z');
    }
  } finally {
    await db.close();
  }
});
test('cash uses normal unresolved and classified totals; withdrawals are not rewritten', async () => {
  const { db, cash, repo } = await setup();
  try {
    await repo.importBatch([
      {
        source: 'test',
        sourceId: 'withdrawal',
        accountId: 'bank',
        owner: 'rodion',
        bookedAt: '2026-09-12T09:00:00Z',
        currency: 'EUR',
        amountMinor: '-10000',
        description: 'ATM cash withdrawal',
      },
    ]);
    const withdrawal = (await repo.list('rodion'))[0]!;
    await repo.classify(
      withdrawal.id,
      0,
      {
        kind: 'internal_transfer',
        category: null,
        reason: 'Moving money into cash wallet',
      },
      'rodion',
    );
    const created = await cash.create('rodion', input());
    let rows = await repo.list('rodion');
    assert.equal(
      expenseSummary(rows).byCurrency[0]!.unresolvedOutflowMinor,
      '1234',
    );
    assert.equal(expenseSummary(rows).byCurrency[0]!.personalExpenseMinor, '0');
    await repo.classify(
      created.id,
      0,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Confirmed cash lunch',
      },
      'rodion',
    );
    rows = await repo.list('rodion');
    assert.equal(
      expenseSummary(rows).byCurrency[0]!.personalExpenseMinor,
      '1234',
    );
    assert.equal(
      expenseSummary(rows).byCurrency[0]!.unresolvedOutflowMinor,
      '0',
    );
    const converted = await convertedSpending(repo, rows, 'EUR');
    assert.equal(
      converted.rows.find((row) => row.id === created.id)?.convertedAmountMinor,
      '-1234',
    );
    assert.equal(
      rows.find((row) => row.id === withdrawal.id)?.kind,
      'internal_transfer',
    );
    assert.equal(rows.find((row) => row.id === withdrawal.id)?.revision, 1);
  } finally {
    await db.close();
  }
});
test('failed imports roll back the new cash account and its audit; existing account policy is preserved', async () => {
  const { db, cash } = await setup();
  try {
    const failing: Database = {
      ...db,
      transaction: (action) =>
        db.transaction((tx) =>
          action({
            ...tx,
            query: (sql, params) => {
              if (sql.includes('INSERT INTO transactions'))
                throw new Error('synthetic failure');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await assert.rejects(
      new CashTransactions(failing).create('rodion', input()),
      /synthetic failure/,
    );
    assert.equal((await db.query('SELECT * FROM own_accounts')).rows.length, 0);
    assert.equal(
      (await db.query('SELECT * FROM account_audit_events')).rows.length,
      0,
    );
    const value = input();
    await cash.create('rodion', value);
    await new Accounts(db).upsert(
      {
        source: 'manual_cash',
        accountId: 'cash:rodion:EUR',
        owner: 'rodion',
        label: 'Personal choice',
        purpose: 'business',
      },
      'rodion',
    );
    await assert.rejects(
      cash.create('rodion', input()),
      /cash_account_not_personal/,
    );
    assert.equal(
      (await new Accounts(db).list('rodion'))[0]!.purpose,
      'business',
    );
    assert.equal((await cash.create('rodion', value)).created, false);
  } finally {
    await db.close();
  }
});
