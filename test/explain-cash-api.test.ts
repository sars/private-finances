import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web } from '../src/web.js';
import { TransactionTriage } from '../src/transaction-triage.js';

test('cash and saved explanations share authenticated review, exact accounting and explicit confirmation', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const config = {
    port: 0,
    mode: 'postgres' as const,
    release: 'test',
    passwords: {
      rodion: 'synthetic-rodion-password',
      katya: 'synthetic-katya-password',
    },
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  const request = (
    path: string,
    owner: 'rodion' | 'katya' = 'rodion',
    body?: Record<string, string>,
  ) =>
    fetch(`http://127.0.0.1:${config.port}${path}`, {
      redirect: 'manual',
      method: body ? 'POST' : 'GET',
      headers: {
        authorization:
          'Basic ' +
          Buffer.from(owner + ':' + config.passwords[owner]).toString('base64'),
        ...(body
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(body ? { body: new URLSearchParams(body) } : {}),
    });
  try {
    const bootstrap = await (await request('/api/bootstrap')).json();
    const form = {
      csrf: bootstrap.csrf,
      requestId: randomUUID(),
      amount: '12.35',
      currency: 'EUR',
      date: '2026-09-01',
      description: 'Synthetic cash coffee',
      owner: 'katya',
    };
    assert.equal(
      (
        await request('/api/cash-transactions', 'rodion', {
          ...form,
          csrf: 'bad',
        })
      ).status,
      403,
    );
    const response = await request('/api/cash-transactions', 'rodion', form);
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(
      (await (await request('/api/cash-transactions', 'rodion', form)).json())
        .transactionId,
      created.transactionId,
    );
    assert.equal(
      (
        await request('/api/cash-transactions', 'rodion', {
          ...form,
          amount: '99',
        })
      ).status,
      409,
    );
    const rows = await repo.list('rodion');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amountMinor, '-1235');
    assert.equal(rows[0]!.source, 'manual_cash');
    assert.equal(rows[0]!.kind, 'unresolved');
    assert.equal((await repo.list('katya')).length, 0);
    const detail = await (
      await request('/api/review?detailOnly=1&id=' + created.transactionId)
    ).json();
    assert.equal(detail.replies.length, 1);
    assert.equal(detail.replies[0].source, 'app');
    assert.equal(detail.replies[0].input_text, form.description);
    assert.equal(detail.replies[0].workflow_state, 'disabled');
    const bank = await (
      await request('/api/transaction-details?id=' + created.transactionId)
    ).json();
    assert.ok(
      bank.details.fields.some(
        (f: { label: string; value: string }) =>
          f.label === 'Purchase date (day only)' && f.value === form.date,
      ),
    );
    // Either member may explain the other's payment. The explanation belongs
    // to the payment's owner and says which of them wrote it.
    const kate = await (await request('/api/bootstrap', 'katya')).json();
    const byKate = await request('/api/payment-explanations', 'katya', {
      csrf: kate.csrf,
      id: created.transactionId,
      revision: '0',
      text: 'Kate knows what this was',
      requestId: randomUUID(),
    });
    assert.equal(byKate.status, 200);
    const kateExplanation = (await byKate.json()).explanation;
    assert.equal(kateExplanation.owner, 'rodion');
    assert.equal(kateExplanation.answered_by, 'katya');
    assert.deepEqual(
      (
        await (
          await request(
            '/api/review?detailOnly=1&id=' + created.transactionId,
            'katya',
          )
        ).json()
      ).replies.map((r: { answered_by: string }) => r.answered_by),
      ['katya', 'rodion'],
    );
    // A payment that does not exist is still not found.
    assert.equal(
      (
        await request('/api/payment-explanations', 'katya', {
          csrf: kate.csrf,
          id: '00000000-0000-4000-8000-000000000000',
          revision: '0',
          text: 'No such payment',
          requestId: randomUUID(),
        })
      ).status,
      400,
    );
    const explanation = detail.replies[0];
    // Explicit cash review must not generate unrelated automatic model requests.
    await repo.importBatch([
      {
        source: 'synthetic',
        sourceId: 'bank-note',
        accountId: 'a',
        owner: 'rodion',
        bookedAt: '2026-09-01T12:00:00Z',
        amountMinor: '-200',
        currency: 'EUR',
        description: 'Mobile phone refill',
      },
    ]);
    const bankPayment = (await repo.list('rodion')).find(
      (t) => t.source === 'synthetic',
    )!;
    const noteResponse = await request('/api/payment-explanations', 'rodion', {
      csrf: bootstrap.csrf,
      id: bankPayment.id,
      revision: '0',
      text: 'Owner is checking this payment',
      requestId: randomUUID(),
    });
    assert.equal(noteResponse.status, 200);
    const note = await noteResponse.json();
    assert.equal(note.explanation.input_text, 'Owner is checking this payment');
    assert.equal(note.suggestionStatus, 'disabled');
    let calls = 0;
    const triage = new TransactionTriage(db, () => {
      calls++;
      throw Error('no automatic request');
    });
    assert.equal(await triage.processOne(), false);
    assert.equal(calls, 0);
    const confirm = {
      csrf: bootstrap.csrf,
      id: created.transactionId,
      revision: '0',
      kind: 'personal_expense',
      category: 'Food / Groceries',
      reason: form.description,
      explanationId: explanation.id,
    };
    assert.equal((await request('/classify', 'rodion', confirm)).status, 303);
    assert.equal((await request('/classify', 'rodion', confirm)).status, 409);
    const saved = (await repo.list('rodion')).find(
      (t) => t.id === created.transactionId,
    )!;
    assert.equal(saved.kind, 'personal_expense');
    assert.equal(saved.revision, 1);
    const history = await (
      await request('/api/review?detailOnly=1&id=' + created.transactionId)
    ).json();
    const confirmed = history.replies.find(
      (r: { id: string }) => r.id === explanation.id,
    );
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.input_text, form.description);
    const summary = await (await request('/api/summary')).json();
    assert.ok(JSON.stringify(summary).includes('1235'));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  }
});
