import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Accounts } from '../src/accounts.js';
import { Repository } from '../src/repository.js';
import type { BankAccount, BankConnector } from '../src/connectors/types.js';
import {
  cardKey,
  recipientKey,
  registerCards,
  reidentifyTransfers,
  retireCounterpartyMemory,
} from '../src/counterparty-identity.js';

/**
 * Recognising a transfer between the household's own accounts.
 *
 * The bank usually gives only a name. It gives a counterparty IBAN on about a
 * third of transfers, and a masked card number on 38 payments in a ledger of
 * 4,064 — of which 22 cards appear exactly once, because the number printed is
 * the other party's card and the other party is usually a stranger.
 *
 * So a name carries this, and a name is not evidence but a statement the owner
 * has made. It comes from the rules they already wrote, and from the payments
 * they categorise by hand — "if any problem — i can manually recategorize it",
 * which only has to happen once per counterparty because it is remembered.
 *
 * Matching by amount was removed deliberately: the system does not hold all of
 * the household's accounts, so the other half of a real transfer is often
 * absent, and a pair that does appear may be two unrelated payments.
 */

const base = {
  source: 'synthetic',
  accountId: 'personal',
  owner: 'rodion' as const,
  currency: 'EUR',
  description: 'Some merchant',
};

async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO own_accounts(source,account_id,owner,label,purpose)
     VALUES('synthetic','personal','rodion','Everyday','personal'),
           ('synthetic','katya','katya','Katya everyday','personal'),
           ('synthetic','unreviewed','rodion','Unknown','unreviewed'),
           ('synthetic','broker','rodion','Broker','investment')`,
  );
  return { db, repo: new Repository(db) };
}

const transfer = (sourceId: string, description: string, amount = '-5000') => ({
  ...base,
  sourceId,
  bookedAt: '2026-08-01T10:00:00Z',
  amountMinor: amount,
  sourceDetails: { mcc: 4829, description },
});

const correct = (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.transaction((tx) => reidentifyTransfers(tx));

test('a masked card number reduces to the issuer digits and the last four', () => {
  // The same card, padded two ways by two banks, must produce one key.
  assert.equal(cardKey('537541******1234'), cardKey('537541****1234'));
  assert.equal(cardKey('537541******1234'), '537541-1234');
  // Only the last four cannot tell two cards apart, so it is refused.
  assert.equal(cardKey('****1234'), null);
  assert.equal(cardKey('Some merchant'), null);
  assert.equal(cardKey(undefined), null);
});

test('one key covers every spelling of a name, without merging two people', () => {
  // This is the whole reason names are held here rather than left to the rules,
  // which match the bank's string exactly and so need one rule per spelling.
  assert.equal(recipientKey('Катерина Б.'), recipientKey('КАТЕРИНА Б'));
  assert.equal(recipientKey('  Катерина   Б.  '), 'катерина б');
  assert.equal(recipientKey('«Іван Іванов»'), 'іван іванов');
  assert.notEqual(recipientKey('Катерина Б.'), recipientKey('Катерина Бондар'));
  // A single token names nobody, and a card number belongs to the card path.
  assert.equal(recipientKey('Катерина'), null);
  assert.equal(recipientKey('537541******1234'), null);
});

test('the counterparties the owner declared in their rules are taken as stated', async () => {
  const { db, repo } = await setup();
  try {
    await db.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,active)
       VALUES($1,'rodion',1,'description','Kate Baeva','internal_transfer',true)`,
      [randomUUID()],
    );
    await repo.importBatch([
      // The rule's own spelling, and a spelling no rule covers. Both are the
      // same person, and one entry answers for both.
      transfer('exact', 'Kate Baeva'),
      transfer('other-spelling', 'KATE BAEVA.'),
    ]);
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 2);
    assert.deepEqual(
      (await repo.list()).map((t) => t.kind),
      ['internal_transfer', 'internal_transfer'],
    );
  } finally {
    await db.close();
  }
});

test('categorising a transfer by hand answers the next one to the same person', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([transfer('first', 'Катерина Б.')]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'internal_transfer',
        category: null,
        reason: 'This is money to Kate',
      },
      'rodion',
    );
    // A later payment to the same person, spelled differently by the bank.
    await repo.importBatch([transfer('second', 'КАТЕРИНА Б', '-3300')]);
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 1);
    const kinds = new Map(
      (await repo.list()).map((t) => [t.sourceId, t.kind] as const),
    );
    assert.equal(kinds.get('second'), 'internal_transfer');
  } finally {
    await db.close();
  }
});

test('categorising a transfer by hand writes a rule, not a private row', async () => {
  const { db, repo } = await setup();
  try {
    // The owner asked why a second store existed when rules already say
    // "payments matching this text are of this kind". It does not any more:
    // their decision lands in the rule list, where they can see and edit it.
    await repo.importBatch([transfer('taught-as-rule', 'Ольга Науменко')]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      { kind: 'non_personal', category: null, reason: 'Not our spending' },
      'rodion',
    );
    const rules = await db.query(
      `SELECT match_field, match_value, kind, active FROM classification_rules`,
    );
    assert.deepEqual(rules.rows, [
      {
        match_field: 'description',
        match_value: 'Ольга Науменко',
        kind: 'non_personal',
        active: true,
      },
    ]);
  } finally {
    await db.close();
  }
});

test('a counterparty already covered by a rule does not get a second one', async () => {
  const { db, repo } = await setup();
  try {
    // The bank writes the same person's name with different punctuation from
    // one payment to the next. A rule already covers them, so categorising
    // another of their payments must not add a near-duplicate beside it — that
    // is the rule proliferation this design exists to avoid.
    await db.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,active)
       VALUES($1,'rodion',1,'description','Ольга Науменко','non_personal',true)`,
      [randomUUID()],
    );
    await repo.importBatch([transfer('variant', 'ОЛЬГА НАУМЕНКО.')]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      { kind: 'non_personal', category: null, reason: 'Not our spending' },
      'rodion',
    );
    const rules = await db.query(
      "SELECT match_value FROM classification_rules WHERE match_field='description'",
    );
    assert.deepEqual(
      rules.rows.map((r) => r.match_value),
      ['Ольга Науменко'],
      'one rule for one person, whatever the bank spelled',
    );
  } finally {
    await db.close();
  }
});

test('a rule made from a retired entry reads as the bank wrote it', async () => {
  const { db, repo } = await setup();
  try {
    // The owner reads this list, so a rule has to carry the bank's own wording
    // rather than the flattened key used for matching. Normalising without
    // btrim leaves the trailing space that a full stop becomes, the lookup for
    // a real spelling then finds nothing, and the rule ends up named
    // "катерина б" — which is how two of them reached production.
    await db.query(`CREATE TABLE IF NOT EXISTS counterparty_memory (
      match_key text PRIMARY KEY, key_type text NOT NULL,
      kind text NOT NULL, learned_from text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(
      `INSERT INTO counterparty_memory(match_key,key_type,kind,learned_from)
       VALUES('катерина б','name','internal_transfer','human')`,
    );
    await repo.importBatch([transfer('spelled', 'Катерина Б.')]);
    assert.equal(await db.transaction((tx) => retireCounterpartyMemory(tx)), 1);
    const rules = await db.query(
      "SELECT match_value FROM classification_rules WHERE match_field='description'",
    );
    assert.deepEqual(
      rules.rows.map((r) => r.match_value),
      ['Катерина Б.'],
    );
  } finally {
    await db.close();
  }
});

test('deciding a transfer was spending after all un-teaches the counterparty', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([transfer('taught', 'Петро Петренко')]);
    const first = (await repo.list())[0]!;
    await repo.classify(
      first.id,
      first.revision,
      { kind: 'internal_transfer', category: null, reason: 'Our own money' },
      'rodion',
    );
    const corrected = (await repo.list())[0]!;
    // The owner realises it was a payment to somebody else. The same action
    // that taught it must undo it, or the mistake quietly persists.
    await repo.classify(
      corrected.id,
      corrected.revision,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'Actually a person I paid',
      },
      'rodion',
    );
    const retired = await db.query(
      `SELECT active FROM classification_rules WHERE match_value='Петро Петренко'`,
    );
    assert.deepEqual(
      retired.rows,
      [{ active: false }],
      'retired rather than deleted, so the rule list still shows it existed',
    );
    await repo.importBatch([transfer('later', 'Петро Петренко', '-2000')]);
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 0);
    const kinds = new Map(
      (await repo.list()).map((t) => [t.sourceId, t.kind] as const),
    );
    assert.equal(kinds.get('later'), 'unresolved');
  } finally {
    await db.close();
  }
});

test('two payments of the same amount on our accounts teach nothing', async () => {
  const { db, repo } = await setup();
  try {
    // An earlier version read this as a transfer identifying itself. The owner
    // had it removed: we do not hold every account of the household, so a pair
    // like this is as likely to be two unrelated payments, and trusting it
    // takes real spending out of the totals.
    await repo.importBatch([
      transfer('out', 'Іван Іванов', '-7500'),
      {
        ...base,
        accountId: 'katya',
        owner: 'katya' as const,
        sourceId: 'in',
        bookedAt: '2026-08-01T10:02:00Z',
        amountMinor: '7500',
        sourceDetails: { mcc: 4829, description: 'Від: Родіон С.' },
      },
    ]);
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 0);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM classification_rules WHERE match_field='description'",
        )
      ).rows[0]!.n,
      0,
      'nothing was written anywhere, least of all a rule',
    );
  } finally {
    await db.close();
  }
});

test('a transfer naming one of our own cards is household money, not spending', async () => {
  const { db, repo } = await setup();
  try {
    await registerCards(db, { source: 'synthetic', accountId: 'katya' }, [
      '537541******1234',
    ]);
    // The padding differs from what the provider published, which must not
    // matter, and a card-to-card transfer states the card and nothing else.
    await repo.importBatch([transfer('to-card', '537541****1234')]);
    const report = await correct(db);
    assert.equal(report.byEvidence.card, 1);
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'internal_transfer');
    assert.equal(
      row.category,
      null,
      'moving our own money is not spending on anything',
    );
    assert.equal(row.classificationSource, 'identity');
    assert.equal(row.provisional, false);
  } finally {
    await db.close();
  }
});

test('a card the owner identified by hand is remembered with no account behind it', async () => {
  const { db, repo } = await setup();
  try {
    // Kate's card at a bank this system does not hold. There is no account to
    // register it against, but the owner's decision still carries.
    await repo.importBatch([transfer('card-first', '413884******2716')]);
    const row = (await repo.list())[0]!;
    await repo.classify(
      row.id,
      row.revision,
      { kind: 'internal_transfer', category: null, reason: 'Our card' },
      'rodion',
    );
    await repo.importBatch([transfer('card-later', '413884****2716', '-900')]);
    const report = await correct(db);
    assert.equal(report.byEvidence.card, 1);
    const kinds = new Map(
      (await repo.list()).map((t) => [t.sourceId, t.kind] as const),
    );
    assert.equal(kinds.get('card-later'), 'internal_transfer');
  } finally {
    await db.close();
  }
});

test('a card registered to one account is never claimed by another', async () => {
  const { db } = await setup();
  try {
    assert.equal(
      await registerCards(db, { source: 'synthetic', accountId: 'katya' }, [
        '537541******1234',
      ]),
      1,
    );
    assert.equal(
      await registerCards(db, { source: 'synthetic', accountId: 'broker' }, [
        '537541****1234',
      ]),
      0,
      'the same card cannot resolve to two accounts',
    );
  } finally {
    await db.close();
  }
});

test('an ordinary purchase is never identified by the name of its shop', async () => {
  const { db, repo } = await setup();
  try {
    await db.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,active)
       VALUES($1,'rodion',1,'description','Катерина Б.','internal_transfer',true)`,
      [randomUUID()],
    );
    await repo.importBatch([
      // Same text, but a grocery code: a purchase narrative names a shop, not a
      // recipient, so the owner's statement must not reach it.
      {
        ...base,
        sourceId: 'groceries',
        bookedAt: '2026-08-02T10:00:00Z',
        amountMinor: '-1200',
        sourceDetails: { mcc: 5411, description: 'Катерина Б.' },
      },
    ]);
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 0);
    // A grocery purchase names no counterparty, so it is not examined at all —
    // which is why it does not even count as looked at and left alone.
    assert.equal(report.unchanged, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('a transfer to an account nobody has described stays as it was', async () => {
  const { db, repo } = await setup();
  try {
    await registerCards(db, { source: 'synthetic', accountId: 'unreviewed' }, [
      '444455******6666',
    ]);
    await repo.importBatch([transfer('to-unknown', '444455******6666')]);
    const report = await correct(db);
    assert.equal(report.byEvidence.card, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('a transfer to an investment account is an investment, not an internal transfer', async () => {
  const { db, repo } = await setup();
  try {
    await registerCards(db, { source: 'synthetic', accountId: 'broker' }, [
      '111122******3333',
    ]);
    await repo.importBatch([transfer('to-broker', '111122******3333')]);
    await correct(db);
    assert.equal((await repo.list())[0]!.kind, 'investment');
  } finally {
    await db.close();
  }
});

test('an identifier claimed by two accounts settles nothing', async () => {
  const { db, repo } = await setup();
  try {
    const { identifierHashFor } = await import('../src/accounts.js');
    const hash = identifierHashFor({
      scheme: 'iban',
      value: 'LV80BANK0000435195001',
    });
    await db.query(
      "UPDATE own_accounts SET identifier_hash=$1 WHERE account_id IN ('katya','broker')",
      [hash],
    );
    await repo.importBatch([
      {
        ...base,
        sourceId: 'ambiguous',
        bookedAt: '2026-08-07T10:00:00Z',
        amountMinor: '-1500',
        sourceDetails: { mcc: 4829, counterIban: 'LV80BANK0000435195001' },
      },
    ]);
    const report = await correct(db);
    assert.equal(report.byEvidence.iban, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test("the owner's word reaches a payment the model had already settled", async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([transfer('settled-by-model', 'Ольга Науменко')]);
    const row = (await repo.list())[0]!;
    // A confident automatic pass filed this as ordinary spending. Nothing about
    // that is a person's decision, so it must not shield the payment from what
    // the owner says later about who was paid.
    await db.query(
      `UPDATE transactions SET kind='personal_expense', provisional=false,
         classification_source='model',
         category_id=(SELECT id FROM category_tree WHERE slug='food.groceries')
       WHERE id=$1`,
      [row.id],
    );
    await db.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,active)
       VALUES($1,'rodion',1,'description','Ольга Науменко','non_personal',true)`,
      [randomUUID()],
    );
    const report = await correct(db);
    assert.equal(report.byEvidence.name, 1);
    const after = (await repo.list())[0]!;
    assert.equal(after.kind, 'non_personal');
    assert.equal(
      after.category,
      null,
      'the guessed category goes with the kind',
    );
  } finally {
    await db.close();
  }
});

test('a payment that names nobody is never examined at all', async () => {
  const { db, repo } = await setup();
  try {
    // Widening the envelope must not turn this into a sweep of the whole
    // ledger: a statement about who was paid cannot speak to a purchase that
    // names no counterparty, and looking anyway would cost a query per row.
    await repo.importBatch([
      {
        ...base,
        sourceId: 'plain-purchase',
        bookedAt: '2026-08-01T10:00:00Z',
        amountMinor: '-1200',
        sourceDetails: { mcc: 5411, description: 'MAXIMA' },
      },
    ]);
    const report = await correct(db);
    assert.equal(report.unchanged, 0, 'not even looked at');
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('a payment the owner classified by hand is their answer and is left alone', async () => {
  const { db, repo } = await setup();
  try {
    await registerCards(db, { source: 'synthetic', accountId: 'katya' }, [
      '537541******1234',
    ]);
    await repo.importBatch([transfer('decided', '537541******1234')]);
    const row = (await repo.list())[0]!;
    // The owner says this really was groceries money they were repaying, even
    // though it went to our own card. A correction pass must not argue.
    await repo.classify(
      row.id,
      row.revision,
      {
        kind: 'personal_expense',
        category: 'Food / Groceries',
        reason: 'It really was for groceries',
      },
      'rodion',
    );
    const report = await correct(db);
    assert.equal(report.byEvidence.card, 0);
    assert.equal((await repo.list())[0]!.kind, 'personal_expense');
  } finally {
    await db.close();
  }
});

test('correcting transfers twice changes nothing the second time', async () => {
  const { db, repo } = await setup();
  try {
    await registerCards(db, { source: 'synthetic', accountId: 'katya' }, [
      '537541******1234',
    ]);
    await repo.importBatch([transfer('idempotent', '537541******1234')]);
    assert.equal((await correct(db)).byEvidence.card, 1);
    const revision = (await repo.list())[0]!.revision;
    assert.equal(
      (await correct(db)).byEvidence.card,
      0,
      'nothing left to correct',
    );
    assert.equal((await repo.list())[0]!.revision, revision);
  } finally {
    await db.close();
  }
});

test('an account discovered from a provider registers the cards on it', async () => {
  const { db } = await setup();
  try {
    await new Accounts(db).discover({
      source: 'monobank',
      accountId: 'mono:katya:black',
      owner: 'katya',
      label: 'Black',
      iban: 'LV80BANK0000435195001',
      cards: ['537541******1234', 'not a card'],
    });
    const registered = await db.query(
      `SELECT scheme FROM own_account_identifiers
       WHERE account_id='mono:katya:black' ORDER BY scheme`,
    );
    assert.deepEqual(
      registered.rows.map((r) => r.scheme),
      ['card', 'iban'],
      'both identifiers, and the value that is not a card is dropped',
    );
  } finally {
    await db.close();
  }
});

test('a sync recognises a transfer to a counterparty already identified', async () => {
  const { db, repo } = await setup();
  try {
    const { syncBank } = await import('../src/bank-sync.js');
    await db.query(
      `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,active)
       VALUES($1,'rodion',1,'description','Kate Baeva','internal_transfer',true)`,
      [randomUUID()],
    );
    const account: BankAccount = {
      source: 'monobank',
      owner: 'rodion',
      accountId: 'mono:rodion:iron',
      providerAccountId: 'iron',
      currency: 'UAH',
      label: 'Iron',
    };
    const connector: BankConnector = {
      source: 'monobank',
      owner: 'rodion',
      accounts: async () => [account],
      transactions: async () => [
        {
          source: 'monobank',
          accountId: account.accountId,
          owner: 'rodion',
          sourceId: 'sync-transfer',
          bookedAt: '2026-09-01T12:00:00Z',
          currency: 'UAH',
          amountMinor: '-3000000',
          description: 'Transfer',
          status: 'booked',
          sourceDetails: { mcc: 4829, description: 'KATE BAEVA' },
        },
      ],
    };
    await syncBank(
      repo,
      connector,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-02T00:00:00Z'),
    );
    const row = (await repo.list()).find(
      (t) => t.sourceId === 'sync-transfer',
    )!;
    assert.equal(
      row.kind,
      'internal_transfer',
      'recognised on the sync that imported it, not only by a migration',
    );
  } finally {
    await db.close();
  }
});
