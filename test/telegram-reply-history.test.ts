import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { TelegramClarifications } from '../src/telegram.js';
import { web } from '../src/web.js';

test("saved replies survive confirmation/rejection; the list is the signed-in member's and a payment detail is its own owner's", async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  await repo.importBatch(
    ['rodion', 'katya'].map((owner) => ({
      source: 'synthetic',
      sourceId: owner,
      accountId: owner,
      owner,
      bookedAt: '2026-09-01T12:00:00Z',
      amountMinor: '-3000',
      currency: 'EUR',
      description: 'Synthetic ticket purchase',
    })),
  );
  let messageId = 40;
  const telegram = new TelegramClarifications(
    db,
    { chatId: '-123', userIds: { rodion: '101', katya: '102' } },
    {
      async send() {
        return { messageId: ++messageId };
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    },
  );
  const own = (await repo.list('rodion'))[0]!;
  const foreign = (await repo.list('katya'))[0]!;
  let updateId = 0;
  for (const [owner, row, user] of [
    ['rodion', own, 101],
    ['katya', foreign, 102],
  ] as const) {
    await telegram.queue(row.id, row.revision, 'What was this?', owner);
    assert.equal(await telegram.dispatchOne(), 'sent');
    for (const status of ['pending', 'confirmed', 'rejected']) {
      const id = ++updateId;
      assert.equal(
        await telegram.receive({
          update_id: id,
          message: {
            chat: { id: -123 },
            from: { id: user, is_bot: false },
            reply_to_message: { message_id: messageId },
            text: `${owner} ${status} explanation`,
          },
        }),
        'accepted',
      );
      const input = (
        await db.query(
          'UPDATE telegram_proposal_inputs SET status=$1 WHERE update_id=$2 RETURNING id',
          [status, id],
        )
      ).rows[0]!;
      if (status !== 'pending')
        await db.query(
          'INSERT INTO telegram_reply_workflows(id,input_id,transaction_id,revision,owner,chat_id,state) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), input.id, row.id, row.revision, owner, '-123', status],
        );
    }
  }
  // A newer classification must not erase the owner's earlier explanation.
  await repo.classify(
    own.id,
    own.revision,
    {
      kind: 'personal_expense',
      category: 'Entertainment / Events',
      reason: 'Synthetic confirmation',
    },
    'rodion',
  );
  const config = {
    port: 0,
    mode: 'postgres' as const,
    release: 'test',
    telegram,
    passwords: {
      rodion: 'synthetic-owner-password',
      katya: 'synthetic-kate-password',
    },
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as { port: number }).port;
  const get = async (path: string, actor: 'rodion' | 'katya' = 'rodion') => {
    const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      headers: {
        authorization:
          'Basic ' +
          Buffer.from(`${actor}:${config.passwords[actor]}`).toString('base64'),
      },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.equal((await telegram.pending('rodion')).length, 1);
    for (const owner of ['rodion', 'katya'] as const) {
      const list = await get('/api/review?window=current_month', owner);
      assert.equal(list.replies.length, 3);
      assert.deepEqual(
        list.replies.map((r: { status: string }) => r.status).sort(),
        ['confirmed', 'pending', 'rejected'],
      );
      assert.ok(
        list.replies.every((r: { input_text: string }) =>
          r.input_text.startsWith(owner),
        ),
      );
    }
    const detail = await get(`/api/review?detailOnly=1&id=${own.id}`);
    assert.equal(detail.replies.length, 3);
    assert.equal(
      detail.replies.find((r: { status: string }) => r.status === 'confirmed')
        .workflow_state,
      'confirmed',
    );
    assert.equal(detail.replies[0].transaction_description, own.description);
    // Either member may open the other's payment, and what was said about it
    // comes with it rather than being hidden from the member reading it.
    const otherDetail = await get(`/api/review?detailOnly=1&id=${foreign.id}`);
    assert.equal(otherDetail.replies.length, 3);
    assert.ok(
      otherDetail.replies.every((r: { input_text: string }) =>
        r.input_text.startsWith('katya'),
      ),
    );
    assert.deepEqual((await get('/api/review?detailOnly=1')).replies, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
