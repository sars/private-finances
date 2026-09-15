import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories, ruleMatches } from '../src/categories.js';

/**
 * Matching a rule against a payment is decided twice: in TypeScript, where a
 * proposal is built, and in SQL, where the triage query asks whether a payment
 * has a rule at all. Two implementations of one rule can drift, so this holds
 * both to the same table of cases rather than trusting that they agree.
 */
const CASES: readonly {
  field: 'description' | 'counterparty' | 'description_contains';
  value: string;
  description: string;
  counterparty: string | null;
  expected: boolean;
  note: string;
}[] = [
  {
    field: 'description',
    value: 'hotline.finance',
    description: 'hotline.finance',
    counterparty: null,
    expected: true,
    note: 'an exact rule still matches the whole description',
  },
  {
    field: 'description',
    value: 'Sent money to Rodion Salnik',
    description: 'TRANSFER-2262675011 Sent money to Rodion Salnik',
    counterparty: null,
    expected: false,
    note: 'and still refuses a fragment, which is why contains exists',
  },
  {
    field: 'description_contains',
    value: 'Sent money to Rodion Salnik',
    description: 'TRANSFER-2262675011 Sent money to Rodion Salnik',
    counterparty: null,
    expected: true,
    note: 'the reference number changes every transfer; the name does not',
  },
  {
    field: 'description_contains',
    value: 'Sent money to Rodion Salnik',
    description: 'TRANSFER-2080703994 Sent money to INGA VOLKOVIČA',
    counterparty: null,
    expected: false,
    note: 'a different recipient on the same bank template is not a match',
  },
  {
    field: 'description_contains',
    value: 'inga volkovica',
    description: 'TRANSFER-1761810659 Sent money to Inga Volkovica',
    counterparty: null,
    expected: true,
    note: 'case is ignored, so one rule covers the bank shouting a name',
  },
  {
    field: 'description_contains',
    value: '100% wool',
    description: 'Shop selling 100% wool things',
    counterparty: null,
    expected: true,
    note: 'a per-cent sign is text the owner typed, not a wildcard',
  },
  {
    field: 'description_contains',
    value: 'a_b',
    description: 'axb',
    counterparty: null,
    expected: false,
    note: 'nor is an underscore a single-character wildcard',
  },
  {
    field: 'counterparty',
    value: 'LV80BANK0000435195001',
    description: 'Anything at all',
    counterparty: 'LV80BANK0000435195001',
    expected: true,
    note: 'a stated identifier still matches exactly',
  },
  {
    field: 'counterparty',
    value: 'LV80BANK0000435195001',
    description: 'Anything at all',
    counterparty: null,
    expected: false,
    note: 'and a payment without one never matches',
  },
];

test('the SQL and TypeScript rule matchers agree on every case', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    for (const c of CASES) {
      assert.equal(
        ruleMatches(
          { field: c.field, value: c.value },
          c.description,
          c.counterparty,
        ),
        c.expected,
        `TypeScript: ${c.note}`,
      );
      const sql = await db.query<{ matched: boolean }>(
        'SELECT rule_matches($1,$2,$3,$4) AS matched',
        [c.field, c.value, c.description, c.counterparty],
      );
      assert.equal(sql.rows[0]!.matched, c.expected, `SQL: ${c.note}`);
    }
  } finally {
    await db.close();
  }
});

test('a contains rule answers every transfer in a series, and an exact rule still wins', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const categories = new Categories(db);
  await repo.importBatch(
    [
      'TRANSFER-2262675011 Sent money to Rodion Salnik',
      'TRANSFER-2085337291 Sent money to Rodion Salnik',
      'TRANSFER-1850277417 Sent money to Rodion Salnik',
      'TRANSFER-2080703994 Sent money to INGA VOLKOVIČA',
    ].map((description, i) => ({
      source: 'synthetic',
      sourceId: String(i),
      accountId: 'a',
      owner: 'rodion' as const,
      currency: 'EUR',
      amountMinor: '-10000',
      description,
      bookedAt: '2026-09-11T09:31:01Z',
      status: 'booked' as const,
    })),
  );
  try {
    const contains = await categories.saveRule('rodion', {
      matcher: {
        field: 'description_contains',
        value: 'Sent money to Rodion Salnik',
      },
      kind: 'internal_transfer',
      categoryId: null,
      confirmed: true,
      reason: 'Money moved between my own accounts',
    });
    assert.equal(contains.matcher.field, 'description_contains');
    const rules = await categories.listRules('rodion');
    const rows = await repo.list('rodion');
    const matching = (description: string) =>
      rows
        .filter((r) => r.description === description)
        .flatMap(() =>
          rules.filter((rule) =>
            ruleMatches({ ...rule.matcher }, description, null),
          ),
        );
    // One rule, three payments the bank wrote three different ways.
    assert.equal(
      rows.filter(
        (r) => matching(r.description).length > 0 && r.amountMinor === '-10000',
      ).length,
      3,
    );
    // The stranger on the same template is untouched.
    assert.equal(
      matching('TRANSFER-2080703994 Sent money to INGA VOLKOVIČA').length,
      0,
    );
  } finally {
    await db.close();
  }
});

test('the merchants the owner named are filed, and only the transfer leaves a rule', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    (
      [
        ['rodion', 'hotline.finance'],
        ['katya', 'hotline.finance'],
        ['rodion', 'ТОВ "БМ Фікс"'],
        ['rodion', 'ФОП Величко Степан Андрійович'],
        ['katya', 'ФОП Петраков Євгеній Сергійович'],
        ['rodion', "ТОВ 'Явір-2000'"],
        ['rodion', 'Дія | Штрафи'],
        ['rodion', 'TRANSFER-2262675011 Sent money to Rodion Salnik'],
        ['rodion', 'TRANSFER-1850277417 Sent money to Rodion Salnik'],
      ] as const
    ).map(([owner, description], i) => ({
      source: 'synthetic',
      sourceId: String(i),
      accountId: 'a',
      owner,
      currency: 'UAH',
      amountMinor: '-50000',
      description,
      bookedAt: '2026-07-18T09:31:01Z',
      status: 'booked' as const,
    })),
  );
  try {
    // Version 37 already ran against the empty database above, so replay it
    // over rows that exist — the production shape, where the ledger is already
    // full when the owner's decision is written down.
    await db.query('DELETE FROM schema_versions WHERE version=37');
    await migrate(db);
    const byDescription = new Map(
      (await repo.list()).map((row) => [row.description, row]),
    );
    const filed = (description: string) => byDescription.get(description)!;
    assert.equal(
      filed('hotline.finance').category,
      'Transport / Car / Insurance',
    );
    assert.equal(
      filed('ТОВ "БМ Фікс"').category,
      'Transport / Car / Maintenance',
    );
    assert.equal(
      filed('ФОП Величко Степан Андрійович').category,
      'Transport / Car / Maintenance',
    );
    assert.equal(
      filed('ФОП Петраков Євгеній Сергійович').category,
      'Sport / Racket sports',
    );
    assert.equal(filed("ТОВ 'Явір-2000'").category, 'Utilities / Security');
    assert.equal(filed('Дія | Штрафи').category, 'Transport / Car / Fines');
    // One contains rule answers both transfers whatever reference each carries,
    // and money moved between the owner's own accounts is not spending at all.
    for (const reference of ['2262675011', '1850277417']) {
      const row = filed(`TRANSFER-${reference} Sent money to Rodion Salnik`);
      assert.equal(row.kind, 'internal_transfer');
      assert.equal(row.category, null);
    }
    // The owner asked for a rule for the transfers and nowhere else: naming a
    // merchant files the payments that exist, it does not also decide every
    // future payment. So exactly one rule is written and none of the six
    // merchants leaves one behind, even though Katya paid two of them.
    const categories = new Categories(db);
    for (const owner of ['rodion', 'katya'] as const) {
      // It covers both members: money reaching Rodion's account has not been
      // spent by anyone, whichever of them sent it.
      assert.deepEqual(
        (await categories.listRules(owner)).map((r) => [
          r.matcher.field,
          r.matcher.value,
          r.kind,
        ]),
        [
          [
            'description_contains',
            'Sent money to Rodion Salnik',
            'internal_transfer',
          ],
        ],
        `${owner} has exactly the transfer rule`,
      );
    }
  } finally {
    await db.close();
  }
});

test('a ledger that has never seen those merchants gains nothing from the migration', async () => {
  // The decisions are observations about one household's spending, not part of
  // the schema. Writing them unconditionally seeded seven rules per member into
  // every database, including the fixtures other tests build on.
  const db = memoryDatabase();
  await migrate(db);
  try {
    const categories = new Categories(db);
    for (const owner of ['rodion', 'katya'] as const)
      assert.deepEqual(await categories.listRules(owner), []);
    // The categories the owner named are part of the tree either way: they are
    // vocabulary, and an empty ledger should still offer them.
    const paths = (await categories.listNodes()).map((n) => n.path);
    assert.ok(paths.includes('Utilities / Security'));
    assert.ok(paths.includes('Transport / Car / Fines'));
  } finally {
    await db.close();
  }
});
