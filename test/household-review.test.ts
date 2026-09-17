import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { Categories } from '../src/categories.js';
import { Refunds } from '../src/refunds.js';
import { TelegramClarifications } from '../src/telegram.js';
import { web } from '../src/web.js';

/**
 * The household is the unit the totals describe, so either member may read and
 * decide the other's payment in the application, exactly as either may answer a
 * Telegram question addressed to the other. Everything below is done by rodion
 * to katya's payments: each action has to succeed, the payment has to stay on
 * katya's account, and every record of who acted has to say rodion.
 */
test("either member decides the other's payment, and the record says who did", async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch([
    {
      source: 'synthetic',
      sourceId: 'katya-shop',
      accountId: 'katya-card',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '-4200',
      description: 'Synthetic shop',
      bookedAt: '2026-09-01T10:00:00Z',
    },
    {
      source: 'synthetic',
      sourceId: 'katya-jacket',
      accountId: 'katya-card',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '-2500',
      description: 'Synthetic jacket',
      bookedAt: '2026-09-02T10:00:00Z',
    },
    {
      source: 'synthetic',
      sourceId: 'katya-jacket-back',
      accountId: 'katya-card',
      owner: 'katya',
      currency: 'EUR',
      amountMinor: '2500',
      description: 'Synthetic jacket returned',
      bookedAt: '2026-09-04T10:00:00Z',
    },
  ]);
  const owned = await repo.list('katya');
  const payment = owned.find((t) => t.description === 'Synthetic shop')!;
  const jacket = owned.find((t) => t.description === 'Synthetic jacket')!;
  const credit = owned.find(
    (t) => t.description === 'Synthetic jacket returned',
  )!;
  const tag = await new Categories(db).saveTag('household review');
  let sent = 0;
  const telegram = new TelegramClarifications(
    db,
    { chatId: '-123', userIds: { rodion: '101', katya: '102' } },
    {
      async send() {
        return { messageId: ++sent };
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    },
  );
  const config = {
    port: 0,
    mode: 'postgres' as const,
    release: 'test',
    telegram,
    passwords: {
      rodion: 'synthetic-rodion-password',
      katya: 'synthetic-katya-password',
    },
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.port = (server.address() as { port: number }).port;
  const request = (
    path: string,
    actor: 'rodion' | 'katya' = 'rodion',
    body?: Record<string, string>,
  ) =>
    fetch(base + path, {
      redirect: 'manual',
      method: body ? 'POST' : 'GET',
      headers: {
        authorization:
          'Basic ' +
          Buffer.from(actor + ':' + config.passwords[actor]).toString('base64'),
        ...(body
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
  const revisionOf = async (id: string) =>
    (await repo.list('katya')).find((t) => t.id === id)!.revision;
  /** Who did what to a payment, leaving out the importer's own arrival event. */
  const decisions = async (id: string) =>
    (
      await db.query<{ actor: string; event: string }>(
        "SELECT actor,event FROM audit_events WHERE transaction_id=$1 AND actor<>'importer' ORDER BY created_at,id",
        [id],
      )
    ).rows.map((row) => [String(row.event), String(row.actor)]);
  try {
    // Nothing here is open to an unauthenticated caller.
    assert.equal((await fetch(base + '/api/review?detailOnly=1')).status, 401);
    const csrf = (await (await request('/api/bootstrap')).json()).csrf;

    // Reading katya's payment as rodion.
    const detail = await (
      await request('/api/review?detailOnly=1&id=' + payment.id)
    ).json();
    assert.deepEqual(
      detail.transactions.map((t: { id: string; owner: string }) => [
        t.id,
        t.owner,
      ]),
      [[payment.id, 'katya']],
    );

    // A tag, then the routine/exceptional label, then the explanation, then the
    // decision: each one is posted by rodion against katya's payment.
    assert.equal(
      (
        await request('/tags', 'rodion', {
          csrf,
          id: payment.id,
          tagId: tag.id,
        })
      ).status,
      303,
    );
    assert.deepEqual(
      (await new Categories(db).tags('katya', payment.id)).map((t) => t.name),
      [tag.name],
    );

    assert.equal(
      (
        await request('/spending-pattern', 'rodion', {
          csrf,
          id: payment.id,
          revision: String(payment.revision),
          annotationRevision: '0',
          pattern: 'exceptional',
          reason: 'Decided for the household',
        })
      ).status,
      303,
    );
    const annotation = (
      await db.query<{ owner: string }>(
        'SELECT owner FROM spending_patterns WHERE transaction_id=$1',
        [payment.id],
      )
    ).rows[0]!;
    assert.equal(String(annotation.owner), 'katya');

    const explanationResponse = await request(
      '/api/payment-explanations',
      'rodion',
      {
        csrf,
        id: payment.id,
        revision: String(payment.revision),
        requestId: randomUUID(),
        text: 'A present rodion knows about',
      },
    );
    assert.equal(explanationResponse.status, 200);
    const explanation = (await explanationResponse.json()).explanation;
    assert.equal(explanation.owner, 'katya');
    assert.equal(explanation.answered_by, 'rodion');

    // `form.owner` is not read: the payment's own row decides whose it is, so
    // the old value (the actor) and the new one (the payment's owner) both work.
    assert.equal(
      (
        await request('/classify', 'rodion', {
          csrf,
          id: payment.id,
          revision: String(await revisionOf(payment.id)),
          owner: 'rodion',
          kind: 'personal_expense',
          category: 'Food / Groceries',
          reason: 'Decided by the other member',
        })
      ).status,
      303,
    );
    const decided = (await repo.list('katya')).find(
      (t) => t.id === payment.id,
    )!;
    assert.equal(decided.owner, 'katya');
    assert.equal(decided.kind, 'personal_expense');
    assert.equal(decided.category, 'Food / Groceries');
    assert.equal((await repo.list('rodion')).length, 0);

    // A refund the other member links and then unlinks.
    assert.equal(
      (
        await request('/refund/link', 'rodion', {
          csrf,
          debitId: jacket.id,
          creditId: credit.id,
          debitRevision: String(jacket.revision),
          creditRevision: String(credit.revision),
          reason: 'Linked for the household',
        })
      ).status,
      303,
    );
    const link = (await new Refunds(db).list('katya'))[0]!;
    assert.equal(link.debitId, jacket.id);
    assert.equal(
      (await new Refunds(db).list('rodion')).length,
      0,
      'the link belongs to the account it sits on',
    );
    assert.ok(
      (
        await (await request('/api/refund-candidates?id=' + credit.id)).json()
      ).links.some((l: { id: string }) => l.id === link.id),
    );
    assert.equal(
      (
        await request('/refund/unlink', 'rodion', {
          csrf,
          id: link.id,
          revision: String(link.revision),
          reason: 'Undone for the household',
        })
      ).status,
      303,
    );

    // A question about katya's payment, asked by rodion, is still addressed to
    // katya's account and recorded against it.
    assert.equal(
      (
        await request('/telegram/queue', 'rodion', {
          csrf,
          id: payment.id,
          revision: String(await revisionOf(payment.id)),
        })
      ).status,
      303,
    );
    const outbox = (
      await db.query<{ owner: string; prompt: string }>(
        'SELECT owner,prompt FROM telegram_outbox WHERE transaction_id=$1',
        [payment.id],
      )
    ).rows[0]!;
    assert.equal(String(outbox.owner), 'katya');
    assert.ok(String(outbox.prompt).startsWith('katya:'));

    // The bank record and the history of the other member's payment.
    const details = await (
      await request('/api/transaction-details?id=' + payment.id)
    ).json();
    assert.equal(
      details.details.id,
      payment.id,
      'the other member sees the bank record of the payment',
    );
    const history = await (
      await request('/api/history?id=' + payment.id)
    ).json();
    assert.deepEqual(
      history.history.map((event: { event: string; actor: string }) => [
        event.event,
        event.actor,
      ]),
      [
        ['imported', 'importer'],
        ['spending_pattern_set', 'rodion'],
        ['classified', 'rodion'],
      ],
      "the history names rodion as the member who decided katya's payment",
    );
    assert.deepEqual(await decisions(jacket.id), [
      ['refund_linked', 'rodion'],
      ['refund_unlinked', 'rodion'],
    ]);
    assert.deepEqual(await decisions(credit.id), [
      ['refund_linked', 'rodion'],
      ['refund_unlinked', 'rodion'],
    ]);

    // A payment that does not exist is still not found, and an unauthenticated
    // caller is still refused.
    const absent = '00000000-0000-4000-8000-000000000000';
    assert.equal(
      (await request('/api/transaction-details?id=' + absent)).status,
      404,
    );
    assert.equal((await request('/api/history?id=' + absent)).status, 404);
    assert.equal(
      (await (await request('/api/review?detailOnly=1&id=' + absent)).json())
        .transactions.length,
      0,
    );
    assert.equal(
      (
        await request('/spending-pattern', 'rodion', {
          csrf,
          id: absent,
          revision: '0',
          annotationRevision: '0',
          pattern: 'routine',
          reason: 'No such payment',
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + '/api/transaction-details?id=' + payment.id)).status,
      401,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
