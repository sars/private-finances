import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import {
  TransactionTriage,
  initializeTransactionTriage,
} from '../src/transaction-triage.js';
import { queueDailyClarifications } from '../src/clarification-cycle.js';
import { TelegramClarifications } from '../src/telegram.js';

/**
 * A confirmed rule that has lost its category.
 *
 * The tree migration moved rule categories through a map of legacy paths and
 * sent everything it did not list to the root catch-all, so fifty-eight
 * owner-confirmed rules came out of it still matching and pointing at
 * Unspecified. Triage read that as a decision and asked nobody; the automatic
 * write refused to file anything under a catch-all. The payment was neither
 * classified nor asked about, and stayed that way.
 */

const base = {
  source: 'synthetic',
  accountId: 'a',
  bookedAt: '2026-09-11T00:00:00Z',
  currency: 'EUR',
  amountMinor: '-1000',
  owner: 'rodion' as const,
};

const silentBot = (
  d: ConstructorParameters<typeof TelegramClarifications>[0],
) =>
  new TelegramClarifications(
    d,
    { chatId: '-123', userIds: { rodion: '101', katya: '102' } },
    {
      async send() {
        throw new Error('no sends');
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    },
  );

async function nodeBySlug(categories: Categories, slug: string) {
  const node = (await categories.listNodes()).find((n) => n.slug === slug);
  assert.ok(node, `missing node ${slug}`);
  return node;
}

test('a rule pointing at the catch-all asks instead of going silent', async () => {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeTransactionTriage);
  try {
    const repo = new Repository(db);
    const categories = new Categories(db);
    const catchAll = await nodeBySlug(categories, 'unspecified');
    await repo.importBatch([
      { ...base, sourceId: 'one', description: 'Shop that lost its category' },
    ]);
    await categories.saveRule('rodion', {
      matcher: { field: 'description', value: 'Shop that lost its category' },
      kind: 'personal_expense',
      categoryId: catchAll.id,
      confirmed: true,
      reason: 'Confirmed before the tree migration flattened it',
    });
    const triage = new TransactionTriage(db, () => ({
      async propose() {
        throw new Error('a confirmed rule must not reach the model');
      },
    }));
    assert.equal(await triage.processOne(), true);

    // The decision is still the rule's — what changes is that a decision the
    // write below will refuse is no longer called ready.
    const row = (await triage.list('rodion'))[0]!;
    assert.equal(row.state, 'uncertain');
    assert.equal((row.decision as { source: string }).source, 'confirmed_rule');

    // Nothing was filed under the catch-all.
    const payment = (await repo.list())[0]!;
    assert.equal(payment.kind, 'unresolved');
    assert.equal(payment.categoryId, null);

    // And the question lane can now see it, which is the whole point.
    const queued = await queueDailyClarifications(
      db,
      silentBot,
      new Date('2026-09-11T12:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    assert.deepEqual(queued, { rodion: 1, katya: 0 });
  } finally {
    await db.close();
  }
});

test('the repair restores what the household decided and retires what it did not', async () => {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeTransactionTriage);
  try {
    const repo = new Repository(db);
    const categories = new Categories(db);
    const catchAll = await nodeBySlug(categories, 'unspecified');
    const clothes = await nodeBySlug(categories, 'clothes');
    const cosmetics = await nodeBySlug(categories, 'beauty.cosmetics');

    const payments = [
      { id: 'agreed-1', description: 'Agreed shop', decided: clothes.id },
      { id: 'agreed-2', description: 'Agreed shop', decided: clothes.id },
      { id: 'split-1', description: 'Split shop', decided: clothes.id },
      { id: 'split-2', description: 'Split shop', decided: cosmetics.id },
      { id: 'never-1', description: 'Never decided shop', decided: null },
      { id: 'drogas-1', description: 'DROGAS 2007', decided: cosmetics.id },
      { id: 'drogas-2', description: 'DROGAS 2007', decided: cosmetics.id },
    ];
    await repo.importBatch(
      payments.map((p) => ({
        ...base,
        sourceId: p.id,
        description: p.description,
      })),
    );
    const ledger = await repo.list();
    for (const payment of payments) {
      if (!payment.decided) continue;
      const stored = ledger.find((t) => t.sourceId === payment.id)!;
      await db.query(
        `UPDATE transactions SET kind='personal_expense', category_id=$1,
         classification_source='human' WHERE id=$2`,
        [payment.decided, stored.id],
      );
    }

    // The damage, as the tree migration left it: the rules still match and are
    // still confirmed, and every one of them points at the root catch-all.
    const ruleIds = new Map<string, string>();
    for (const value of [
      'Agreed shop',
      'Split shop',
      'Never decided shop',
      'DROGAS 2007',
    ]) {
      const id = randomUUID();
      ruleIds.set(value, id);
      await db.query(
        `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active)
         VALUES($1,'rodion',1,'description',$2,'personal_expense',$3,true)`,
        [id, value, catchAll.id],
      );
      await db.query(
        `INSERT INTO classification_rule_audit(id,owner,rule_id,version,definition,reason)
         VALUES($1,'rodion',$2,1,$3,'Confirmed before the tree migration')`,
        [randomUUID(), id, JSON.stringify({ id })],
      );
    }

    // A payment already caught by the hole: ready, nothing written, nothing
    // asked, and nothing that would ever look at it again.
    const stranded = ledger.find((t) => t.sourceId === 'never-1')!;
    await db.query(
      `INSERT INTO transaction_triage(transaction_id,revision,owner,state,decision,question)
       VALUES($1,$2,'rodion','ready',$3,NULL)`,
      [
        stranded.id,
        stranded.revision,
        JSON.stringify({
          kind: 'personal_expense',
          source: 'confirmed_rule',
          category: 'Unspecified',
          confidence: 1,
        }),
      ],
    );

    await db.query('DELETE FROM schema_versions WHERE version=63');
    await migrate(db);

    const rules = new Map(
      (
        await db.query(
          'SELECT match_value, active, category_id, version FROM classification_rules',
        )
      ).rows.map((r) => [String(r.match_value), r]),
    );

    // One leaf, chosen by a person, twice: that is their answer, so give it back.
    assert.equal(rules.get('Agreed shop')!.active, true);
    assert.equal(rules.get('Agreed shop')!.category_id, clothes.id);
    assert.equal(Number(rules.get('Agreed shop')!.version), 2);

    // Two different answers from the same person is not an answer.
    assert.equal(rules.get('Split shop')!.active, false);
    assert.equal(rules.get('Split shop')!.category_id, catchAll.id);

    // Never decided, so there is nothing to restore.
    assert.equal(rules.get('Never decided shop')!.active, false);

    // Unanimous, and still retired: the owner says this shop's name does not
    // say what was bought there.
    assert.equal(rules.get('DROGAS 2007')!.active, false);
    assert.equal(rules.get('DROGAS 2007')!.category_id, catchAll.id);

    // Every change is a new edition of the rule, with its reason recorded.
    const audit = (
      await db.query(
        'SELECT reason FROM classification_rule_audit WHERE rule_id=$1 AND version=2',
        [ruleIds.get('DROGAS 2007')],
      )
    ).rows;
    assert.equal(audit.length, 1);
    assert.match(String(audit[0]!.reason), /catch-all/);

    // The payment that was already stuck is a question again.
    const triaged = (
      await db.query(
        'SELECT state FROM transaction_triage WHERE transaction_id=$1',
        [stranded.id],
      )
    ).rows[0]!;
    assert.equal(triaged.state, 'uncertain');

    // Idempotent: nothing is left for a second run to match.
    await db.query('DELETE FROM schema_versions WHERE version=63');
    await migrate(db);
    const versions = (
      await db.query(
        'SELECT match_value, version FROM classification_rules ORDER BY match_value',
      )
    ).rows;
    assert.deepEqual(
      versions.map((r) => Number(r.version)),
      [2, 2, 2, 2],
    );
  } finally {
    await db.close();
  }
});

test('the corrections the owner made after seeing the repair', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const categories = new Categories(db);
    const cosmetics = await nodeBySlug(categories, 'beauty.cosmetics');
    const familyCatchAll = await nodeBySlug(categories, 'family.unspecified');
    const support = await nodeBySlug(categories, 'family.parents_support');
    // The id the migration names. Its meaning is the household's; the test only
    // needs a rule to exist under it.
    const placed = '4574db2f-d0c9-43aa-8148-0792c5491854';

    const rules: [string, string, string][] = [
      [randomUUID(), 'EVA', cosmetics.id],
      [randomUUID(), 'DROGAS 2007', cosmetics.id],
      // Begins with an ambiguous name and is not one: a bare prefix would take
      // it, and the household never said anything about this shop.
      [randomUUID(), 'EVANS', cosmetics.id],
      [placed, 'A recurring transfer', familyCatchAll.id],
    ];
    for (const [id, value, category] of rules)
      await db.query(
        `INSERT INTO classification_rules(id,owner,version,match_field,match_value,kind,category_id,active)
         VALUES($1,'rodion',1,'description',$2,'personal_expense',$3,true)`,
        [id, value, category],
      );

    await db.query('DELETE FROM schema_versions WHERE version=65');
    await migrate(db);

    const after = new Map(
      (
        await db.query(
          'SELECT match_value, active, category_id, version FROM classification_rules',
        )
      ).rows.map((r) => [String(r.match_value), r]),
    );
    assert.equal(after.get('EVA')!.active, false);
    assert.equal(after.get('DROGAS 2007')!.active, false);
    assert.equal(after.get('EVANS')!.active, true);
    assert.equal(after.get('EVANS')!.category_id, cosmetics.id);
    assert.equal(after.get('A recurring transfer')!.active, true);
    assert.equal(after.get('A recurring transfer')!.category_id, support.id);

    // Every change is a new edition carrying why it changed.
    const reasons = (
      await db.query(
        'SELECT reason FROM classification_rule_audit WHERE version=2 ORDER BY reason',
      )
    ).rows.map((r) => String(r.reason));
    assert.equal(reasons.length, 3);

    // Idempotent: nothing is left for a second run to match.
    await db.query('DELETE FROM schema_versions WHERE version=65');
    await migrate(db);
    const versions = (
      await db.query(
        'SELECT version FROM classification_rules ORDER BY match_value',
      )
    ).rows.map((r) => Number(r.version));
    assert.deepEqual(versions, [2, 2, 2, 1]);
  } finally {
    await db.close();
  }
});
