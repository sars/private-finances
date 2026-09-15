import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import {
  correctBankWordedPlacements,
  restPlacements,
} from '../src/resting-place.js';
import { knownCounterparty } from '../src/known-counterparties.js';

/**
 * Two counterparties the bank names in its own words.
 *
 * The July total the owner saw was 1.58 million UAH against a spreadsheet that
 * said 369 thousand, because the resting place placed a 880,894 UAH sole-trader
 * tax payment as household spending. These tests hold the two shapes that
 * caused it, and — more importantly — the payments that must keep resting where
 * they were, because a recogniser that reaches too far takes real spending out
 * of the totals.
 */

const base = {
  source: 'synthetic',
  accountId: 'personal',
  owner: 'rodion' as const,
  bookedAt: '2026-07-28T13:14:05Z',
  currency: 'UAH',
  amountMinor: '-88089449',
  description: 'ГУК Сум.обл/Сумська МТГ/11010500',
};

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
     VALUES('synthetic','personal','rodion','Everyday','personal')`,
  );
  return { db, repo: new Repository(db) };
}

const sweep = (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.transaction((tx) => restPlacements(tx));

test('a treasury payment is business, not the largest expense of the year', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'tax', sourceDetails: { mcc: 4829 } },
    ]);
    const report = await sweep(db);
    assert.equal(report.bankWorded, 1);
    assert.equal(report.byDefault, 0, 'never rests in the catch-all');
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'non_personal');
    assert.equal(
      row.provisional,
      false,
      'the payee is evidence, not a guess, so nothing is left to confirm',
    );
    assert.ok(!row.category, 'tax is not filed under a spending category');
  } finally {
    await db.close();
  }
});

test('the other treasury spellings are recognised too', () => {
  for (const description of [
    'ГУК Сум.обл/Сумська обл/11011001',
    'ГУК в Iв.-Фр.об./ТГ Ів.-Фр./ 18010200',
    'Державна казначейська служба України',
    'УДКСУ у м. Києві',
  ])
    assert.equal(
      knownCounterparty(description)?.kind,
      'non_personal',
      description,
    );
});

test('a merchant whose name merely starts with those letters is left alone', () => {
  for (const description of ['ГУКОВ І СИН', 'Гукало Ltd', 'Guk Coffee'])
    assert.equal(knownCounterparty(description), null, description);
});

test('money moving to our own card leaves the totals but stays to be confirmed', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'own-card',
        amountMinor: '-5000000',
        description: 'Переказ на картку',
        sourceDetails: { mcc: 4829 },
      },
    ]);
    const report = await sweep(db);
    assert.equal(report.bankWorded, 1);
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'internal_transfer');
    assert.equal(
      row.provisional,
      true,
      'thirty-one of thirty-two were ours; the thirty-second was a therapist',
    );
    const history = await repo.history(row.id);
    assert.ok(
      history.some((event) =>
        /one of our own cards/.test(String(event.reason ?? '')),
      ),
      'the owner is told why, in their terms',
    );
  } finally {
    await db.close();
  }
});

test('a transfer that names somebody is not treated as our own money', () => {
  assert.equal(
    knownCounterparty('Переказ на картку', { comment: 'за масаж' }),
    null,
    'a comment names a payee',
  );
  assert.equal(
    knownCounterparty('Переказ на картку', { counterIban: 'UA123456789' }),
    null,
    'a stated account is stronger evidence and is matched a step earlier',
  );
  assert.equal(
    knownCounterparty('Переказ на картку 414949******4092'),
    null,
    'printed card digits describe somebody',
  );
  assert.equal(
    knownCounterparty('Переказ на картку Анні К. за уроки'),
    null,
    'the wording must be the whole description, not part of a narrative',
  );
});

test('ordinary spending still rests where it did', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'groceries',
        amountMinor: '-45000',
        description: 'Rimi',
        sourceDetails: { mcc: 5411 },
      },
      {
        ...base,
        sourceId: 'person',
        amountMinor: '-300000',
        description: 'Анна К.',
        sourceDetails: { mcc: 4829 },
      },
    ]);
    const report = await sweep(db);
    assert.equal(report.bankWorded, 0);
    assert.equal(report.byMcc, 1);
    assert.equal(
      report.byDefault,
      1,
      'a transfer to a person still rests in the catch-all, as ADR 0008 decided',
    );
  } finally {
    await db.close();
  }
});

test('placements already made are corrected, and human decisions are not', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'tax', sourceDetails: { mcc: 4829 } },
      {
        ...base,
        sourceId: 'own-card',
        amountMinor: '-5000000',
        description: 'Переказ на картку',
        sourceDetails: { mcc: 4829 },
      },
      {
        ...base,
        sourceId: 'therapist',
        amountMinor: '-250000',
        description: 'Переказ на картку',
        sourceDetails: { mcc: 4829 },
      },
    ]);
    // Place everything the way the sweep did before the recognisers existed.
    const rows = await repo.list();
    for (const row of rows)
      await db.query(
        `UPDATE transactions SET kind='personal_expense', provisional=true,
           classification_source='default',
           category_id=(SELECT id FROM category_tree WHERE slug='unspecified')
         WHERE id=$1`,
        [row.id],
      );
    // The owner has since said one of them really was spending.
    const therapist = rows.find((row) => row.amountMinor === '-250000')!;
    await db.query(
      `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
       VALUES($1,$2,'rodion','classified','{}','{}','It was for therapy')`,
      [randomUUID(), therapist.id],
    );

    const corrected = await db.transaction((tx) =>
      correctBankWordedPlacements(tx),
    );
    assert.equal(corrected.treasury, 1);
    assert.equal(corrected.ownAccount, 1, 'the decided one is not touched');

    const after = await repo.list();
    const decided = after.find((row) => row.id === therapist.id)!;
    assert.equal(
      decided.kind,
      'personal_expense',
      'a person had decided this one, so it stays spending',
    );
  } finally {
    await db.close();
  }
});
