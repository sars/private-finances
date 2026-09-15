import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { expenseSummary } from '../src/domain.js';
import { Categories } from '../src/categories.js';
import {
  TransactionTriage,
  sufficientAutomaticConfidence,
  initializeTransactionTriage,
  type TriageClassifierFactory,
} from '../src/transaction-triage.js';
import { queueDailyClarifications } from '../src/clarification-cycle.js';
import { TelegramClarifications } from '../src/telegram.js';
const base = {
  source: 'synthetic',
  accountId: 'a',
  bookedAt: '2026-09-11T00:00:00Z',
  currency: 'EUR',
  amountMinor: '-100',
  description: 'Mobile phone refill',
  owner: 'rodion',
};
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeTransactionTriage);
  const repo = new Repository(db);
  const categories = new Categories(db);
  // The household tree is seeded by the migration, so a test asks for the node
  // it wants rather than inventing a parallel one.
  const mobile = (await categories.listNodes()).find(
    (n) => n.slug === 'communication.mobile',
  )!;
  return { db, repo, categories, mobile };
}
const unavailable: TriageClassifierFactory = () => ({
  async propose() {
    return { status: 'disabled' };
  },
});

test('historical evidence stays local, preserves ledger and records provenance without a generic question', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'history',
        description: 'Synthetic investment recipient',
      },
    ]);
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => {
        calls++;
        throw new Error('must stay local');
      },
      {
        schemaVersion: 1,
        entries: [
          {
            id: 'synthetic-investment',
            owner: 'rodion',
            sourceReference: 'synthetic-chat:message-1',
            kind: 'context',
            proposedKind: 'investment',
            statement:
              'The owner identified this payment recipient as an investment.',
            match: {
              source: 'synthetic',
              accountId: 'a',
              description: 'Synthetic investment recipient',
              currency: 'EUR',
              direction: 'outflow',
            },
          },
        ],
      },
    );
    assert.equal(await triage.processOne(), true);
    const rows = await triage.list('rodion');
    assert.equal(rows[0]!.question, null);
    const decision = rows[0]!.decision as {
      kind: string;
      source: string;
      evidence: unknown[];
    };
    assert.equal(decision.kind, 'investment');
    assert.equal(decision.source, 'historical_evidence');
    assert.deepEqual(decision.evidence, [
      {
        id: 'synthetic-investment',
        sourceReference: 'synthetic-chat:message-1',
      },
    ]);
    assert.equal(calls, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
    assert.deepEqual(await triage.list('katya'), []);
  } finally {
    await db.close();
  }
});

test('explicit phone top-up becomes quiet review suggestion without API spend or classification', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([{ ...base, sourceId: 'phone' }]);
    let calls = 0;
    const triage = new TransactionTriage(db, () => ({
      async propose() {
        calls++;
        throw new Error('unexpected');
      },
    }));
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    const rows = await triage.list('rodion');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.question, null);
    assert.equal(
      (rows[0]!.decision as { source: string }).source,
      'phone_signal',
    );
    assert.equal(calls, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
    assert.deepEqual(await triage.list('katya'), []);
    const queued = await queueDailyClarifications(
      db,
      (d) =>
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
        ),
    );
    assert.deepEqual(queued, { rodion: 0, katya: 0 });
  } finally {
    await db.close();
  }
});

test('too many historical matches stop as uncertain without sending evidence to a model', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([{ ...base, sourceId: 'overflow' }]);
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => {
        calls++;
        throw new Error('must stay local');
      },
      {
        schemaVersion: 1,
        entries: Array.from({ length: 4 }, (_, i) => ({
          id: `synthetic-${i}`,
          owner: 'rodion' as const,
          sourceReference: 'synthetic-chat',
          kind: 'context' as const,
          proposedKind: 'investment' as const,
          statement: 'Synthetic evidence.',
          match: {
            source: base.source,
            description: base.description,
            currency: base.currency,
            direction: 'outflow' as const,
          },
        })),
      },
    );
    await triage.processOne();
    assert.equal((await triage.list('rodion'))[0]!.state, 'uncertain');
    assert.equal(calls, 0);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('business account phone top-up is excluded without a personal clarification', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([{ ...base, sourceId: 'business' }]);
    await db.query(
      "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Business','business')",
    );
    const triage = new TransactionTriage(db, unavailable);
    assert.equal(await triage.processOne(), false);
    assert.deepEqual(await triage.list('rodion'), []);
    // The account policy is recorded on the payment rather than applied while
    // drawing a report, so the ledger says what the totals are doing and the
    // owner can mark this one payment personal if it was.
    assert.equal((await repo.list())[0]!.kind, 'non_personal');
    assert.equal(
      (await repo.list())[0]!.storedClassification?.kind,
      'non_personal',
    );
    const history = await repo.history((await repo.list())[0]!.id);
    assert.ok(
      history.some(
        (event) =>
          event.actor === 'account_policy' &&
          event.event === 'account_policy_applied',
      ),
      'the reason is auditable rather than implicit in the reporting code',
    );
  } finally {
    await db.close();
  }
});

test('confirmed exact rules avoid model calls, while unresolved model questions use missing information', async () => {
  const { db, repo, categories, mobile } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'rule', description: 'Exact merchant' },
    ]);
    await categories.saveRule('rodion', {
      matcher: { field: 'description', value: 'Exact merchant' },
      kind: 'personal_expense',
      categoryId: mobile.id,
      confirmed: true,
      reason: 'Explicit owner confirmation',
    });
    const triage = new TransactionTriage(db, () => ({
      async propose() {
        throw new Error('should use rule');
      },
    }));
    await triage.processOne();
    assert.equal(
      ((await triage.list('rodion'))[0]!.decision as { source: string }).source,
      'confirmed_rule',
    );
    await repo.importBatch([
      { ...base, sourceId: 'ambiguous', description: 'Transfer' },
    ]);
    const model = new TransactionTriage(db, () => ({
      async propose(_id, _rev, _owner, _context, key) {
        assert.equal(key, 'triage:v2');
        return {
          status: 'proposed',
          id: 'test',
          proposal: {
            kind: 'unresolved',
            category: null,
            confidence: 0.2,
            explanation: 'Is the recipient another account you own?',
          },
        };
      },
    }));
    await model.processOne();
    assert.ok(
      (await model.list('rodion')).some(
        (r) => r.question === 'Is the recipient another account you own?',
      ),
    );
  } finally {
    await db.close();
  }
});

test('disabled and exhausted budget defer; failures and interrupted processing do not blindly retry', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'unknown', description: 'Unknown merchant' },
    ]);
    const triage = new TransactionTriage(db, unavailable);
    await triage.processOne();
    assert.equal((await triage.list('rodion'))[0]!.state, 'deferred');
    assert.equal(await triage.processOne(), false);
    await db.query(
      "UPDATE transaction_triage SET retry_after=now()-interval '1 minute'",
    );
    const exhausted = new TransactionTriage(db, () => ({
      async propose() {
        return { status: 'budget_exhausted' };
      },
    }));
    await exhausted.processOne();
    assert.equal((await triage.list('rodion'))[0]!.state, 'deferred');
    await db.query(
      "UPDATE transaction_triage SET retry_after=now()-interval '1 minute'",
    );
    const failed = new TransactionTriage(db, () => ({
      async propose() {
        return { status: 'failed' };
      },
    }));
    await failed.processOne();
    assert.equal((await triage.list('rodion'))[0]!.state, 'uncertain');
    assert.equal(await failed.processOne(), false);
    await db.query(
      "UPDATE transaction_triage SET state='processing',lease_until=now()-interval '1 minute'",
    );
    assert.equal(await triage.processOne(), false);
    assert.equal((await triage.list('rodion'))[0]!.state, 'uncertain');
  } finally {
    await db.close();
  }
});

test('concurrent claims spend at most once and do not hold a transaction during the model request', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'concurrent', description: 'Unknown merchant' },
    ]);
    let calls = 0;
    const triage = new TransactionTriage(db, () => ({
      async propose() {
        calls++;
        await db.query('SELECT 1');
        return {
          status: 'proposed',
          id: 'test',
          proposal: {
            kind: 'personal_expense',
            category: 'Utilities / Mobile phone',
            confidence: 0.95,
            explanation: 'Strong evidence',
          },
        };
      },
    }));
    await Promise.all([triage.processOne(), triage.processOne()]);
    assert.equal(calls, 1);
    assert.equal((await triage.list('rodion'))[0]!.question, null);
  } finally {
    await db.close();
  }
});

test('inflow and human override stay out of triage; current revision only is listed', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'inflow', amountMinor: '100' },
      { ...base, sourceId: 'human' },
    ]);
    const human = (await repo.list()).find((t) => t.sourceId === 'human')!;
    await repo.classify(
      human.id,
      0,
      { kind: 'unresolved', category: null, reason: 'Keep unresolved' },
      'rodion',
    );
    const triage = new TransactionTriage(db, unavailable);
    assert.equal(await triage.processOne(), false);
    await repo.importBatch([{ ...base, sourceId: 'ordinary' }]);
    await triage.processOne();
    assert.equal((await triage.list('rodion')).length, 1);
    await db.query(
      "UPDATE transactions SET revision=revision+1 WHERE source_id='ordinary'",
    );
    assert.equal((await triage.list('rodion')).length, 0);
  } finally {
    await db.close();
  }
});

test('opt-in applies existing clear suggestions once, records automatic provenance and remains manually reversible', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([{ ...base, sourceId: 'auto' }]);
    await new TransactionTriage(db, unavailable).processOne();
    const triage = new TransactionTriage(db, unavailable, undefined, {
      autoCategorizeClearExpenses: true,
    });
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    const row = (await repo.list())[0]!;
    assert.equal(row.kind, 'personal_expense');
    assert.equal(row.revision, 1);
    const audit = (
      await db.query("SELECT * FROM audit_events WHERE event='auto_classified'")
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor, 'transaction_triage');
    assert.equal(
      (audit[0]!.after_value as any).provenance.decision.source,
      'phone_signal',
    );
    assert.equal((audit[0]!.before_value as any).revision, 0);
    await repo.classify(
      row.id,
      row.revision,
      { kind: 'unresolved', category: null, reason: 'Owner correction' },
      'rodion',
    );
    assert.equal(await triage.processOne(), false);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('automatic model decisions require threshold and personal kind; source and human changes invalidate responses', async () => {
  for (const scenario of [
    'clear',
    'low',
    'investment',
    'source_changed',
    'human_changed',
    'business',
    'business_changed',
  ]) {
    const { db, repo } = await setup();
    try {
      await repo.importBatch([
        { ...base, sourceId: scenario, description: 'Synthetic court booking' },
      ]);
      if (scenario === 'business')
        await db.query(
          "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Business','business')",
        );
      const triage = new TransactionTriage(
        db,
        () => ({
          async propose(id, revision) {
            if (scenario === 'business_changed')
              await db.query(
                "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Business','business')",
              );
            if (scenario === 'source_changed')
              await repo.importBatch([
                { ...base, sourceId: scenario, description: 'Changed purpose' },
              ]);
            if (scenario === 'human_changed')
              await repo.classify(
                id,
                revision,
                { kind: 'unresolved', category: null, reason: 'Owner hold' },
                'rodion',
              );
            return {
              status: 'proposed',
              id: 'synthetic-proposal',
              proposal: {
                kind:
                  scenario === 'investment' ? 'investment' : 'personal_expense',
                category:
                  scenario === 'investment' ? null : 'Utilities / Mobile phone',
                confidence: scenario === 'low' ? 0.94 : 0.95,
                explanation: 'Synthetic context',
              },
            };
          },
        }),
        undefined,
        { autoCategorizeClearExpenses: true },
      );
      await triage.processOne();
      const row = (await repo.list())[0]!;
      assert.equal(
        row.kind,
        scenario === 'clear'
          ? 'personal_expense'
          : scenario === 'business' || scenario === 'business_changed'
            ? 'non_personal'
            : 'unresolved',
        scenario,
      );
      const audit = (
        await db.query(
          "SELECT after_value FROM audit_events WHERE event='auto_classified'",
        )
      ).rows;
      assert.equal(audit.length, scenario === 'clear' ? 1 : 0, scenario);
      if (scenario === 'clear')
        assert.equal(
          (audit[0]!.after_value as any).provenance.decision.proposalId,
          'synthetic-proposal',
        );
      if (scenario === 'business' || scenario === 'business_changed')
        assert.equal(await triage.processOne(), false);
    } finally {
      await db.close();
    }
  }
});

test('new owner rules and historical exclusions outrank stored model suggestions without a repeat loop', async () => {
  for (const evidence of ['rule', 'history'] as const) {
    const { db, repo, categories } = await setup();
    try {
      const description = 'Synthetic prior model payment';
      await repo.importBatch([{ ...base, sourceId: evidence, description }]);
      let calls = 0;
      const model: TriageClassifierFactory = () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'synthetic-proposal',
            proposal: {
              kind: 'personal_expense',
              category: 'Utilities / Mobile phone',
              confidence: 0.99,
              explanation: 'Synthetic previous model answer',
            },
          };
        },
      });
      await new TransactionTriage(db, model).processOne();
      if (evidence === 'rule')
        await categories.saveRule('rodion', {
          confirmed: true,
          matcher: { field: 'description', value: description },
          kind: 'non_personal',
          categoryId: null,
          reason: 'Synthetic owner exclusion',
        });
      const triage = new TransactionTriage(
        db,
        model,
        evidence === 'history'
          ? {
              schemaVersion: 1,
              entries: [
                {
                  id: 'synthetic-exclusion',
                  owner: 'rodion',
                  sourceReference: 'synthetic:owner-statement',
                  kind: 'context',
                  proposedKind: 'investment',
                  statement: 'Synthetic owner confirmed investment.',
                  match: {
                    source: 'synthetic',
                    accountId: 'a',
                    description,
                    currency: 'EUR',
                    direction: 'outflow',
                  },
                },
              ],
            }
          : undefined,
        { autoCategorizeClearExpenses: true },
      );
      assert.equal(await triage.processOne(), true);
      assert.equal(await triage.processOne(), false);
      assert.equal(calls, 1);
      assert.equal(
        (await repo.list())[0]!.kind,
        evidence === 'rule' ? 'non_personal' : 'unresolved',
      );
      const decision = (
        await db.query('SELECT decision FROM transaction_triage')
      ).rows[0]!.decision as {
        kind: string;
        source: string;
      };
      assert.equal(
        decision.kind,
        evidence === 'rule' ? 'non_personal' : 'investment',
      );
      assert.equal(
        decision.source,
        evidence === 'rule' ? 'confirmed_rule' : 'historical_evidence',
      );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM audit_events WHERE event='auto_classified'",
          )
        ).rows.length,
        evidence === 'rule' ? 1 : 0,
      );
    } finally {
      await db.close();
    }
  }
});

test('an owner rule added during a model request blocks automatic application and does not starve later payments', async () => {
  const { db, repo, categories } = await setup();
  try {
    const description = 'Synthetic in-flight payment';
    await repo.importBatch([
      { ...base, sourceId: 'inflight-rule', description },
    ]);
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          await categories.saveRule('rodion', {
            confirmed: true,
            matcher: { field: 'description', value: description },
            kind: 'non_personal',
            categoryId: null,
            reason: 'Synthetic owner exclusion',
          });
          return {
            status: 'proposed',
            id: 'synthetic-proposal',
            proposal: {
              kind: 'personal_expense',
              category: 'Utilities / Mobile phone',
              confidence: 0.99,
              explanation: 'Synthetic stale model answer',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), true);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
    assert.equal((await triage.list('rodion'))[0]!.state, 'uncertain');
    assert.equal(await triage.processOne(), true);
    assert.equal((await repo.list())[0]!.kind, 'non_personal');
    assert.equal(await triage.processOne(), false);
    await repo.importBatch([
      { ...base, sourceId: 'next-phone', bookedAt: '2026-09-10T00:00:00Z' },
    ]);
    assert.equal(await triage.processOne(), true);
    assert.equal(
      (await repo.list()).find((row) => row.sourceId === 'next-phone')!.kind,
      'personal_expense',
    );
    assert.equal(await triage.processOne(), false);
  } finally {
    await db.close();
  }
});

test('startup seeding is idempotent and preserves a category the owner moved', async () => {
  const { ensureStarterCategories } = await import('../src/categories.js');
  const { db, categories } = await setup();
  try {
    const custom = await categories.saveNode({ name: 'My hobbies' });
    const existingRacket = (await categories.listNodes()).find(
      (n) => n.slug === 'sport.racket',
    )!;
    const racket = await categories.saveNode({
      id: existingRacket.id,
      name: 'Racket sports',
      parentId: custom.id,
    });
    await ensureStarterCategories(db);
    await ensureStarterCategories(db);
    const nodes = await categories.listNodes();
    assert.equal(nodes.filter((n) => n.name === 'Sport').length, 1);
    // Seeding repairs what is missing, identified by slug. It must not drag a
    // category back to where the seed happens to put it.
    assert.equal(nodes.find((n) => n.id === racket.id)!.parentId, custom.id);
    assert.equal(
      nodes.find((n) => n.id === racket.id)!.path,
      'My hobbies / Racket sports',
    );
  } finally {
    await db.close();
  }
});

test('exact consumer signature reuses only a current model audit and records original provenance', async () => {
  const { db, repo } = await setup();
  try {
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'original-paid-proposal',
            proposal: {
              kind: 'personal_expense',
              category: 'Utilities / Mobile phone',
              confidence: 0.97,
              explanation: 'Synthetic consumer merchant context',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    const input = {
      ...base,
      description: 'Synthetic telecom merchant',
      sourceDetails: { mcc: 4814 },
    };
    await repo.importBatch([{ ...input, sourceId: 'original' }]);
    await triage.processOne();
    const original = (await repo.list())[0]!;
    const originalAudit = (
      await db.query(
        "SELECT id FROM audit_events WHERE event='auto_classified'",
      )
    ).rows[0]!;
    await repo.importBatch([{ ...input, sourceId: 'repeat' }]);
    await triage.processOne();
    assert.equal(calls, 1);
    const repeated = (await repo.list()).find((t) => t.sourceId === 'repeat')!;
    assert.equal(repeated.kind, 'personal_expense');
    const audit = (
      await db.query(
        "SELECT after_value FROM audit_events WHERE event='auto_classified' AND transaction_id=$1",
        [repeated.id],
      )
    ).rows[0]!.after_value as any;
    assert.equal(audit.provenance.decision.source, 'model_cache');
    assert.equal(audit.provenance.decision.originalAuditId, originalAudit.id);
    assert.equal(
      audit.provenance.decision.proposalId,
      'original-paid-proposal',
    );
    await repo.classify(
      original.id,
      original.revision,
      { kind: 'non_personal', category: null, reason: 'Owner correction' },
      'rodion',
    );
    await repo.importBatch([{ ...input, sourceId: 'after-owner-correction' }]);
    await triage.processOne();
    assert.equal(
      calls,
      2,
      'human correction invalidates donor; no cache chaining',
    );
    await repo.importBatch([
      { ...input, sourceId: 'blocked-by-human-conflict' },
    ]);
    await triage.processOne();
    assert.equal(
      calls,
      3,
      'conflicting human audit blocks reuse even with a new model donor',
    );
  } finally {
    await db.close();
  }
});

test('model cache rejects changed signatures, financial MCC and corrected source revisions', async () => {
  const { db, repo } = await setup();
  try {
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category: 'Utilities / Mobile phone',
              confidence: 0.99,
              explanation: 'Synthetic test',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    const input = {
      ...base,
      description: 'Synthetic consumer',
      sourceDetails: { mcc: 4814 },
    };
    await repo.importBatch([{ ...input, sourceId: 'donor' }]);
    await triage.processOne();
    for (const [index, override] of [
      { description: 'Other consumer' },
      { accountId: 'other' },
      { sourceDetails: { mcc: 6012 } },
      { sourceDetails: { mcc: 5411 } },
    ].entries()) {
      await repo.importBatch([
        { ...input, ...override, sourceId: `different-${index}` },
      ]);
      await triage.processOne();
      assert.equal(calls, index + 2);
    }
    await repo.importBatch([
      { ...input, sourceId: 'donor', amountMinor: '-200' },
    ]);
    await repo.importBatch([{ ...input, sourceId: 'after-source-change' }]);
    await triage.processOne();
    assert.equal(calls, 6, 'original audit revision must remain current');
  } finally {
    await db.close();
  }
});

test('generic Other proposals remain unapplied without repeated calls', async () => {
  const { db, repo, categories } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'generic-other',
        description: 'Synthetic ambiguous merchant',
      },
    ]);
    let calls = 0;
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose(_id, _revision, _owner, _context, key) {
          calls++;
          assert.equal(key, 'triage:v2');
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category: 'Unspecified',
              confidence: 1,
              explanation: 'Generic fallback',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    assert.equal(calls, 1);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
  } finally {
    await db.close();
  }
});

test('consumer evidence supports .93 ready proposals and exact cache reuse without another model call', async () => {
  const { db, repo, categories } = await setup();
  try {
    let calls = 0;
    const factory: TriageClassifierFactory = () => ({
      async propose() {
        calls++;
        return {
          status: 'proposed',
          id: 'synthetic-sport-proposal',
          proposal: {
            kind: 'personal_expense',
            category: 'Sport / Racket sports',
            confidence: 0.93,
            explanation: 'Consumer court-booking context',
          },
        };
      },
    });
    const input = {
      ...base,
      description: 'Synthetic court booking',
      sourceDetails: { mcc: 7997 },
    };
    await repo.importBatch([{ ...input, sourceId: 'sport-ready' }]);
    await new TransactionTriage(db, factory).processOne();
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
    const triage = new TransactionTriage(db, factory, undefined, {
      autoCategorizeClearExpenses: true,
    });
    assert.equal(await triage.processOne(), true);
    assert.equal((await repo.list())[0]!.category, 'Sport / Racket sports');
    assert.equal(calls, 1);
    await repo.importBatch([{ ...input, sourceId: 'sport-repeated' }]);
    assert.equal(await triage.processOne(), true);
    assert.equal(calls, 1, '.93 supported decision can seed bounded reuse');
    assert.equal(await triage.processOne(), false);
    const audits = (
      await db.query(
        "SELECT after_value FROM audit_events WHERE event='auto_classified'",
      )
    ).rows;
    assert.equal(audits.length, 2);
    assert.ok(
      audits.every(
        (a) =>
          (a.after_value as any).provenance.policy ===
          'confirmed_rules_and_clear_expenses:v4',
      ),
    );
    assert.ok(
      audits.some(
        (a) =>
          (a.after_value as any).provenance.decision.source === 'model_cache',
      ),
    );
  } finally {
    await db.close();
  }
});

test('moderate confidence needs supported consumer evidence; rejected ready candidates do not loop', async () => {
  for (const scenario of [
    'unsupported',
    'transfer',
    'business',
    'exceptional',
  ]) {
    const { db, repo } = await setup();
    try {
      await repo.importBatch([
        {
          ...base,
          sourceId: scenario,
          description:
            scenario === 'transfer'
              ? 'Transfer to synthetic recipient'
              : scenario === 'exceptional'
                ? 'Synthetic business purchase'
                : 'Synthetic court booking',
          sourceDetails: { mcc: scenario === 'unsupported' ? 6012 : 7997 },
        },
      ]);
      if (scenario === 'business')
        await db.query(
          "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Business','business')",
        );
      let calls = 0;
      const factory: TriageClassifierFactory = () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category: 'Utilities / Mobile phone',
              confidence: 0.93,
              explanation: 'Synthetic medium-confidence context',
            },
          };
        },
      });
      await new TransactionTriage(db, factory).processOne();
      const triage = new TransactionTriage(db, factory, undefined, {
        autoCategorizeClearExpenses: true,
      });
      assert.equal(
        await triage.processOne(),
        scenario !== 'business',
        scenario,
      );
      assert.equal(await triage.processOne(), false, scenario);
      assert.equal(calls, scenario === 'business' ? 0 : 1, scenario);
      assert.equal(
        (await repo.list())[0]!.kind,
        scenario === 'business' ? 'non_personal' : 'unresolved',
        scenario,
      );
      if (scenario === 'business')
        assert.deepEqual(await triage.list('rodion'), []);
      else
        assert.equal(
          (await triage.list('rodion'))[0]!.state,
          'ready',
          'rejected automatic decision stays reviewable',
        );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM audit_events WHERE event='auto_classified'",
          )
        ).rows.length,
        0,
      );
    } finally {
      await db.close();
    }
  }
});

test('high model confidence cannot override contradictory signals; explicit confirmed rules keep priority', async () => {
  const { db, repo, categories, mobile } = await setup();
  try {
    const factory: TriageClassifierFactory = () => ({
      async propose() {
        return {
          status: 'proposed',
          id: 'synthetic',
          proposal: {
            kind: 'personal_expense',
            category: 'Utilities / Mobile phone',
            confidence: 0.99,
            explanation: 'Synthetic high-confidence prediction',
          },
        };
      },
    });
    const triage = new TransactionTriage(db, factory, undefined, {
      autoCategorizeClearExpenses: true,
    });
    for (const [index, description] of [
      'Transfer to synthetic recipient',
      'Synthetic business purchase',
      'Synthetic card wallet refill',
    ].entries()) {
      await repo.importBatch([
        {
          ...base,
          sourceId: `contradiction-${index}`,
          description,
          sourceDetails: { mcc: 7997 },
        },
      ]);
      assert.equal(await triage.processOne(), true);
      assert.equal(
        await triage.processOne(),
        false,
        'rejected .99 proposal does not loop',
      );
      assert.equal(
        (await repo.list()).find(
          (t) => t.sourceId === `contradiction-${index}`,
        )!.kind,
        'unresolved',
      );
    }
    await repo.importBatch([
      {
        ...base,
        sourceId: 'ordinary-unsupported',
        description: 'Synthetic ordinary purchase',
        sourceDetails: { mcc: 5999 },
      },
    ]);
    await triage.processOne();
    assert.equal(
      (await repo.list()).find((t) => t.sourceId === 'ordinary-unsupported')!
        .kind,
      'personal_expense',
      '.99 still supports ordinary non-whitelisted MCC',
    );
    await categories.saveRule('rodion', {
      matcher: {
        field: 'description',
        value: 'Transfer to synthetic recipient',
      },
      kind: 'personal_expense',
      categoryId: mobile.id,
      confirmed: true,
      reason: 'Owner explicitly identified personal purchase',
    });
    await repo.importBatch([
      {
        ...base,
        sourceId: 'confirmed',
        description: 'Transfer to synthetic recipient',
        sourceDetails: { mcc: 7997 },
      },
    ]);
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    assert.equal(
      (await repo.list()).find((t) => t.sourceId === 'confirmed')!.kind,
      'personal_expense',
    );
  } finally {
    await db.close();
  }
});

test('new confirmed rules resolve previously ready decisions once without another model request', async () => {
  for (const kind of [
    'investment',
    'internal_transfer',
    'non_personal',
    'personal_expense',
  ] as const) {
    const { db, repo, categories, mobile } = await setup();
    try {
      const description = 'Synthetic previously ambiguous recipient';
      await repo.importBatch([
        { ...base, sourceId: 'rule-retry', description },
      ]);
      let calls = 0;
      const triage = new TransactionTriage(
        db,
        () => ({
          async propose() {
            calls++;
            return {
              status: 'proposed',
              id: 'synthetic',
              proposal: {
                kind: 'unresolved',
                category: null,
                confidence: 0.5,
                explanation: 'Needs context',
              },
            };
          },
        }),
        undefined,
        { autoCategorizeClearExpenses: true },
      );
      assert.equal(await triage.processOne(), true);
      assert.equal(await triage.processOne(), false);
      const rule = await categories.saveRule('rodion', {
        confirmed: true,
        matcher: { field: 'description', value: description },
        kind,
        categoryId: kind === 'personal_expense' ? mobile.id : null,
        reason: 'Explicit owner instruction',
      });
      assert.equal(await triage.processOne(), true);
      assert.equal(await triage.processOne(), false);
      assert.equal(calls, 1);
      const row = (await repo.list())[0]!;
      assert.equal(row.kind, kind);
      assert.equal(row.revision, 1);
      const audits = (
        await db.query(
          "SELECT after_value FROM audit_events WHERE event='auto_classified'",
        )
      ).rows;
      assert.equal(audits.length, 1);
      assert.deepEqual(
        (
          audits[0]!.after_value as {
            provenance: { decision: { rules: unknown } };
          }
        ).provenance.decision.rules,
        [{ id: rule.id, version: 1 }],
      );
    } finally {
      await db.close();
    }
  }
});

test('conflicting confirmed rules do not loop or classify; resolving the conflict retries locally', async () => {
  const { db, repo, categories } = await setup();
  try {
    const description = 'Synthetic conflict';
    await repo.importBatch([{ ...base, sourceId: 'rule-retry', description }]);
    await categories.saveRule('rodion', {
      confirmed: true,
      matcher: { field: 'description', value: description },
      kind: 'investment',
      categoryId: null,
      reason: 'First instruction',
    });
    const conflict = await categories.saveRule('rodion', {
      confirmed: true,
      matcher: { field: 'description', value: description },
      kind: 'non_personal',
      categoryId: null,
      reason: 'Conflicting instruction',
    });
    const triage = new TransactionTriage(
      db,
      () => {
        throw new Error('Must not request model');
      },
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    assert.equal((await repo.list())[0]!.kind, 'unresolved');
    await categories.saveRule('rodion', {
      ...conflict,
      expectedVersion: 1,
      confirmed: true,
      active: false,
      reason: 'Resolved instruction',
    });
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    assert.equal((await repo.list())[0]!.kind, 'investment');
  } finally {
    await db.close();
  }
});

test('confirmed investment rules classify inflows without sending ordinary incoming money to AI', async () => {
  const { db, repo, categories, mobile } = await setup();
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'investment-inflow',
        description: 'Synthetic investment issuer',
        amountMinor: '500',
      },
      {
        ...base,
        sourceId: 'ordinary-inflow',
        description: 'Synthetic incoming money',
        amountMinor: '500',
      },
      {
        ...base,
        sourceId: 'personal-inflow',
        description: 'Synthetic personal merchant',
        amountMinor: '500',
      },
      {
        ...base,
        sourceId: 'pending-inflow',
        description: 'Synthetic investment issuer',
        amountMinor: '500',
        status: 'pending',
      },
    ]);
    await categories.saveRule('rodion', {
      confirmed: true,
      matcher: { field: 'description', value: 'Synthetic investment issuer' },
      kind: 'investment',
      categoryId: null,
      reason: 'Owner confirmed investment issuer',
    });
    await categories.saveRule('rodion', {
      confirmed: true,
      matcher: { field: 'description', value: 'Synthetic personal merchant' },
      kind: 'personal_expense',
      categoryId: mobile.id,
      reason: 'Owner confirmed merchant',
    });
    const triage = new TransactionTriage(
      db,
      () => {
        throw new Error('No paid classification for inflows');
      },
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    const rows = await repo.list();
    assert.equal(
      rows.find((row) => row.sourceId === 'investment-inflow')!.kind,
      'investment',
    );
    assert.ok(
      rows
        .filter((row) => row.sourceId !== 'investment-inflow')
        .every((row) => row.kind === 'unresolved' && row.revision === 0),
    );
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM audit_events WHERE event='auto_classified'",
        )
      ).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});

test('restaurant predictions need matching consumer MCC and confidence; ready proposals upgrade without a paid retry', async () => {
  for (const scenario of [
    'restaurant',
    'wrong-mcc',
    'wrong-category',
    'low-confidence',
    'transfer',
    'business',
  ] as const) {
    const { db, repo, categories } = await setup();
    try {
      await repo.importBatch([
        {
          ...base,
          sourceId: scenario,
          description:
            scenario === 'transfer'
              ? 'Transfer to synthetic restaurant'
              : 'Synthetic restaurant',
          sourceDetails: { mcc: scenario === 'wrong-mcc' ? 5999 : 5812 },
        },
      ]);
      if (scenario === 'business')
        await db.query(
          "INSERT INTO own_accounts(source,account_id,owner,label,purpose) VALUES('synthetic','a','rodion','Synthetic business','business')",
        );
      let calls = 0;
      const factory: TriageClassifierFactory = () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category:
                scenario === 'wrong-category'
                  ? 'Utilities / Mobile phone'
                  : 'Food / Restaurants / Dining in',
              confidence: scenario === 'low-confidence' ? 0.69 : 0.72,
              explanation: 'Synthetic merchant evidence',
            },
          };
        },
      });
      await new TransactionTriage(db, factory).processOne();
      await db.query(
        "UPDATE transaction_triage SET decision=jsonb_set(decision,'{automaticReviewPolicy}',to_jsonb('clear_personal_expense:v2'::text)) WHERE state='ready'",
      );
      const triage = new TransactionTriage(db, factory, undefined, {
        autoCategorizeClearExpenses: true,
      });
      await triage.processOne();
      assert.equal(
        await triage.processOne(),
        false,
        'rejected candidate does not loop',
      );
      assert.equal(
        (await repo.list())[0]!.kind,
        scenario === 'restaurant'
          ? 'personal_expense'
          : scenario === 'business'
            ? 'non_personal'
            : 'unresolved',
      );
      assert.equal(
        calls,
        scenario === 'business' ? 0 : 1,
        'existing model proposal is reused',
      );
    } finally {
      await db.close();
    }
  }
});

test('money transfer MCC blocks high-confidence automatic expenses for both providers without inferring ownership', async () => {
  const { db, repo, categories } = await setup();
  try {
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category: 'Food / Restaurants / Dining in',
              confidence: 0.99,
              explanation: 'Synthetic merchant interpretation',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    for (const source of ['monobank', 'enablebanking']) {
      await repo.importBatch([
        {
          ...base,
          source,
          sourceId: source,
          description: 'Synthetic dining venue',
          sourceDetails:
            source === 'monobank'
              ? { mcc: 4829 }
              : { merchant_category_code: '4829' },
        },
      ]);
      assert.equal(await triage.processOne(), true);
      assert.equal(
        (await repo.list()).find((t) => t.sourceId === source)!.kind,
        'unresolved',
      );
      assert.equal(
        await triage.processOne(),
        false,
        'rejected proposal does not loop',
      );
    }
  } finally {
    await db.close();
  }
});

test('broad consumer corroboration upgrades stored proposals across provider MCC formats without paid retries', async () => {
  const scenarios = [
    {
      category: 'Food / Groceries',
      details: { mcc: 5411 },
      confidence: 0.7,
      expected: true,
    },
    {
      category: 'Food / Groceries',
      details: { mcc: '5411' },
      confidence: 0.8,
      expected: true,
    },
    {
      category: 'Food / Restaurants / Dining in',
      details: { merchant_category_code: '5812' },
      confidence: 0.7,
      expected: true,
    },
    {
      category: 'Pets',
      details: { merchant_category_code: '5995' },
      confidence: 0.7,
      expected: true,
    },
    {
      category: 'Pets',
      details: { mcc: 5411 },
      confidence: 0.8,
      expected: false,
    },
    {
      category: 'Food / Groceries',
      details: { mcc: 5995 },
      confidence: 0.8,
      expected: false,
    },
    {
      category: 'Pets',
      details: { mcc: 5995 },
      confidence: 0.69,
      expected: false,
    },
    {
      category: 'Pets',
      details: { mcc: 4829 },
      confidence: 0.99,
      expected: false,
    },
    {
      category: 'Pets',
      details: { mcc: '5995x' },
      confidence: 0.8,
      expected: false,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const { db, repo, categories } = await setup();
    try {
      await repo.importBatch([
        {
          ...base,
          sourceId: String(index),
          description: 'Synthetic ordinary shop',
          sourceDetails: scenario.details,
        },
      ]);
      let calls = 0;
      const factory: TriageClassifierFactory = () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: 'synthetic',
            proposal: {
              kind: 'personal_expense',
              category: scenario.category,
              confidence: scenario.confidence,
              explanation: 'Synthetic merchant context',
            },
          };
        },
      });
      await new TransactionTriage(db, factory).processOne();
      await db.query(
        "UPDATE transaction_triage SET decision=jsonb_set(decision,'{automaticReviewPolicy}',to_jsonb('confirmed_rules_and_clear_expenses:v3'::text))",
      );
      const triage = new TransactionTriage(db, factory, undefined, {
        autoCategorizeClearExpenses: true,
      });
      await triage.processOne();
      assert.equal(
        (await repo.list())[0]!.kind,
        scenario.expected ? 'personal_expense' : 'unresolved',
        `scenario ${index}`,
      );
      assert.equal(
        calls,
        1,
        'stored proposal reused without a new model request',
      );
      assert.equal(
        await triage.processOne(),
        false,
        'policy applies at most once',
      );
    } finally {
      await db.close();
    }
  }
});

test('high confidence cannot turn software merchant MCC into transport or generic digital goods into AI tools', () => {
  for (const [mcc, category] of [
    [5734, 'Transport / Public transport'],
    [5818, 'Subscriptions / AI tools'],
  ] as const) {
    assert.equal(
      sufficientAutomaticConfidence(
        {
          description: 'Synthetic merchant',
          amount_minor: '-100',
          status: 'booked',
          source_details: { mcc },
        },
        {
          kind: 'personal_expense',
          category,
          confidence: 0.99,
          explanation: 'Synthetic unsupported interpretation',
          source: 'model',
        },
      ),
      false,
    );
  }
});

test('miscellaneous food stores corroborate groceries but not pets', () => {
  const row = {
    description: 'Synthetic food store',
    amount_minor: '-100',
    status: 'booked',
    source_details: { merchant_category_code: '5499' },
  };
  for (const category of ['Food / Groceries', 'Pets']) {
    assert.equal(
      sufficientAutomaticConfidence(row, {
        kind: 'personal_expense',
        category,
        confidence: 0.7,
        explanation: 'Synthetic evidence',
        source: 'model',
      }),
      category === 'Food / Groceries',
    );
  }
});

test('digital goods allow a broad apps category without inventing a specific AI subscription', () => {
  assert.equal(
    sufficientAutomaticConfidence(
      {
        description: 'Synthetic digital store',
        amount_minor: '-100',
        status: 'booked',
        source_details: { mcc: 5818 },
      },
      {
        kind: 'personal_expense',
        category: 'Apps & services',
        confidence: 0.99,
        explanation: 'Broad merchant evidence',
        source: 'model',
      },
    ),
    true,
  );
});

test('pending clear outflows categorize now without changing bank state or processing income', async () => {
  const { db, repo } = await setup();
  try {
    await repo.importBatch([
      { ...base, sourceId: 'pending-phone', status: 'pending' },
      {
        ...base,
        sourceId: 'pending-income',
        status: 'pending',
        amountMinor: '100',
      },
    ]);
    const triage = new TransactionTriage(db, unavailable, undefined, {
      autoCategorizeClearExpenses: true,
    });
    assert.equal(await triage.processOne(), true);
    assert.equal(await triage.processOne(), false);
    const rows = await repo.list();
    const phone = rows.find((r) => r.sourceId === 'pending-phone')!;
    assert.equal(phone.kind, 'personal_expense');
    assert.equal(phone.category, 'Utilities / Mobile phone');
    assert.equal(phone.status, 'pending');
    // The bank has already taken this money, so categorising it puts it in the
    // total; the pending figure declares the same amount as not yet final.
    assert.equal(
      expenseSummary(rows).byCurrency[0]!.personalExpenseMinor,
      '100',
    );
    assert.equal(
      expenseSummary(rows).byCurrency[0]!.pendingOutflowMinor,
      '100',
    );
    assert.equal(
      rows.find((r) => r.sourceId === 'pending-income')!.kind,
      'unresolved',
    );
  } finally {
    await db.close();
  }
});

test('pending consumer merchant uses the same model threshold and MCC corroboration as booked spending', async () => {
  const { db, repo, categories } = await setup();
  let calls = 0;
  try {
    await repo.importBatch([
      {
        ...base,
        sourceId: 'restaurant',
        description: 'Synthetic dining venue',
        status: 'pending',
        sourceDetails: { mcc: 5812 },
      },
    ]);
    const triage = new TransactionTriage(
      db,
      () => ({
        async propose() {
          calls++;
          return {
            status: 'proposed',
            id: '00000000-0000-4000-8000-000000000001',
            proposal: {
              kind: 'personal_expense',
              category: 'Food / Restaurants / Dining in',
              confidence: 0.8,
              explanation: 'Restaurant merchant corroborated by MCC.',
            },
          };
        },
      }),
      undefined,
      { autoCategorizeClearExpenses: true },
    );
    assert.equal(await triage.processOne(), true);
    const row = (await repo.list())[0]!;
    assert.equal(row.category, 'Food / Restaurants / Dining in');
    assert.equal(row.status, 'pending');
    assert.equal(calls, 1);
    assert.equal(await triage.processOne(), false);
  } finally {
    await db.close();
  }
});
