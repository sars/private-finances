import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, type WorkflowHealth } from '../src/repository.js';
import { Reports, previousReportPeriod } from '../src/reports.js';

const created = '2026-01-01T00:00:00.000Z';
const recent = '2026-01-02T00:00:00.000Z';
test('workflow health distinguishes queued, pending, failed and uncertain with safe timestamps only', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'health-test',
        accountId: 'sensitive-account-reference',
        owner: 'rodion',
        bookedAt: created,
        currency: 'EUR',
        amountMinor: '-987654321',
        description: 'sensitive-financial-description',
      },
    ]);
    const transaction = (await repo.list())[0]!;
    const questionIds: string[] = [];
    for (const [index, state] of [
      'queued',
      'sending',
      'sent',
      'uncertain',
    ].entries()) {
      const id = randomUUID();
      questionIds.push(id);
      await db.query(
        `INSERT INTO telegram_outbox(id,transaction_id,revision,owner,chat_id,prompt,state,created_at,lease_until)
        VALUES($1,$2,$3,'rodion','-123456789','sensitive-question',$4,$5,now()-interval '1 hour')`,
        [id, transaction.id, index, state, index === 3 ? recent : created],
      );
    }
    await db.query('INSERT INTO telegram_updates(update_id) VALUES(812345678)');
    const inputId = randomUUID();
    await db.query(
      "INSERT INTO telegram_proposal_inputs(id,outbox_id,update_id,owner,input_text,created_at) VALUES($1,$2,812345678,'rodion','sensitive-reply',$3)",
      [inputId, questionIds[2], created],
    );
    for (const [revision, state] of [
      'reserved',
      'proposed',
      'failed',
      'stale',
    ].entries())
      await db.query(
        "INSERT INTO classifier_proposals(id,transaction_id,revision,owner,model,state,proposal,created_at) VALUES($1,$2,$3,'rodion','sensitive-model',$4,$5,$6)",
        [
          randomUUID(),
          transaction.id,
          revision,
          state,
          JSON.stringify({ explanation: 'sensitive-proposal' }),
          recent,
        ],
      );
    const report = await new Reports(db).save([], {
      owner: 'all',
      period: previousReportPeriod('month', new Date('2026-09-11T00:00:00Z')),
    });
    await db.query(
      "INSERT INTO report_delivery(id,report_id,actor,chat_id,text,state,created_at) VALUES($1,$2,'rodion','-123456789','sensitive-report','uncertain',$3)",
      [randomUUID(), report.id, created],
    );
    for (const [index, state] of [
      'queued',
      'sending',
      'sent',
      'uncertain',
      'cancelled',
    ].entries())
      await db.query(
        "INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,message,chat_id,state,created_at,lease_until) VALUES($1,'openai_api_key',$2,1,'sensitive-token-reminder','-123456789',$3,$4,now()-interval '1 hour')",
        [randomUUID(), `sensitive-expiry-${index}`, state, created],
      );
    await db.query(
      "INSERT INTO telegram_reply_workflows(id,input_id,transaction_id,revision,owner,chat_id,state,receipt_state,receipt_lease_until) VALUES($1,$2,$3,0,'rodion','-123456789','uncertain','sending',now()-interval '1 hour')",
      [randomUUID(), inputId, transaction.id],
    );
    const health = await repo.health();
    const workflows = health.workflows as Record<string, WorkflowHealth>;
    assert.equal(workflows.replyProposals!.counts!.uncertain, 1);
    assert.equal(workflows.replyReceipts!.counts!.sending, 1);
    assert.equal(workflows.replyReceipts!.expiredSendingCount, 1);
    await db.query(
      "UPDATE telegram_reply_workflows SET receipt_state='uncertain'",
    );
    const updated = (await repo.health()).workflows as Record<
      string,
      WorkflowHealth
    >;
    assert.equal(updated.replyReceipts!.counts!.uncertain, 1);
    assert.deepEqual(workflows.telegramQuestions!.counts, {
      queued: 1,
      sending: 1,
      sent: 1,
      uncertain: 1,
    });
    assert.equal(workflows.telegramQuestions!.total, 4);
    assert.equal(workflows.telegramQuestions!.expiredSendingCount, 1);
    assert.equal(workflows.telegramQuestions!.latestCreatedAt, recent);
    assert.equal(
      workflows.telegramQuestions!.oldestOutstandingCreatedAt,
      created,
    );
    assert.deepEqual(workflows.telegramReplies!.counts, { pending: 1 });
    assert.equal(workflows.telegramReplies!.expiredSendingCount, null);
    assert.deepEqual(workflows.classifier!.counts, {
      reserved: 1,
      proposed: 1,
      failed: 1,
      stale: 1,
    });
    assert.deepEqual(workflows.reportDelivery!.counts, {
      queued: 0,
      sending: 0,
      sent: 0,
      uncertain: 1,
    });
    assert.deepEqual(workflows.credentialReminders!.counts, {
      queued: 1,
      sending: 1,
      sent: 1,
      uncertain: 1,
      cancelled: 1,
    });
    assert.equal(workflows.credentialReminders!.expiredSendingCount, 1);
    const serialized = JSON.stringify(health);
    for (const secret of [
      'sensitive-',
      '987654321',
      '123456789',
      '812345678',
      transaction.id,
      report.id,
      'EUR',
      'rodion',
      'openai_api_key',
    ])
      assert.equal(serialized.includes(secret), false, secret);
  } finally {
    await db.close();
  }
});

test('empty workflow is available with zero counts; missing schema is explicitly unavailable', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    const empty = (await repo.health()).workflows as Record<
      string,
      WorkflowHealth
    >;
    assert.equal(empty.classifier!.availability, 'available');
    assert.equal(empty.classifier!.total, 0);
    assert.equal(empty.classifier!.latestCreatedAt, null);
    assert.equal(empty.classifier!.oldestOutstandingCreatedAt, null);
    assert.deepEqual(empty.classifier!.counts, {
      reserved: 0,
      proposed: 0,
      failed: 0,
      stale: 0,
    });
    await db.query('DROP TABLE credential_reminders');
    const missing = (await repo.health()).workflows as Record<
      string,
      WorkflowHealth
    >;
    assert.deepEqual(missing.credentialReminders, {
      availability: 'unavailable',
      counts: null,
      total: null,
      latestCreatedAt: null,
      oldestOutstandingCreatedAt: null,
      expiredSendingCount: null,
    });
    assert.equal(missing.telegramQuestions!.availability, 'available');
  } finally {
    await db.close();
  }
});
