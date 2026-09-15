import test from 'node:test';
import assert from 'node:assert/strict';
const { replyHistoryStatus, replyTimestamp, repliesForTransaction } =
  await import(
    new URL('../../frontend/src/lib/reply-history.ts', import.meta.url).href
  );

test('saved reply history keeps confirmed and rejected context while distinguishing processing outcomes', () => {
  const replies = [
    {
      id: 'a',
      transaction_id: 'one',
      input_text: 'Synthetic dinner context',
      status: 'pending',
      workflow_state: 'sent',
    },
    {
      id: 'b',
      transaction_id: 'one',
      input_text: 'Synthetic correction',
      status: 'confirmed',
      workflow_state: 'confirmed',
    },
    {
      id: 'c',
      transaction_id: 'one',
      input_text: 'Synthetic alternative',
      status: 'rejected',
      workflow_state: 'rejected',
    },
    {
      id: 'd',
      transaction_id: 'two',
      input_text: 'Unrelated payment context',
      status: 'pending',
      workflow_state: null,
    },
  ];
  assert.deepEqual(
    repliesForTransaction(replies, 'one').map(
      (reply: { id: string }) => reply.id,
    ),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(replyHistoryStatus(replies[0]), {
    input: 'Reply saved',
    workflow: 'Awaiting your confirmation',
    needsAttention: false,
  });
  assert.equal(replyHistoryStatus(replies[1]).input, 'Decision confirmed');
  assert.equal(replyHistoryStatus(replies[2]).input, 'Suggestion rejected');
  assert.equal(
    replyHistoryStatus(replies[3]).workflow,
    'Waiting to be processed',
  );
});

test('failed or stale processing never claims a decision was saved or asks to resend the original reply', () => {
  for (const workflow_state of ['failed', 'uncertain', 'stale']) {
    const status = replyHistoryStatus({ status: 'pending', workflow_state });
    assert.equal(status.input, 'Reply saved');
    assert.equal(status.needsAttention, true);
    assert.doesNotMatch(status.workflow, /confirmed|resend/i);
  }
  assert.equal(
    replyHistoryStatus({ status: 'pending', workflow_state: 'future' })
      .workflow,
    'Processing status unavailable',
  );
  assert.equal(
    replyHistoryStatus({ status: 'confirmed', workflow_state: null }).workflow,
    'Saved in your payment history',
  );
});

test('reply timestamps identify the Riga timezone and handle missing metadata without crashing', () => {
  assert.equal(
    replyTimestamp('2026-09-12T12:00:00Z'),
    '12 Sept 2026, 15:00 · Riga',
  );
  assert.equal(
    replyTimestamp('2026-01-12T12:00:00Z'),
    '12 Jan 2026, 14:00 · Riga',
  );
  assert.equal(replyTimestamp(undefined), 'Time unavailable');
  assert.equal(replyTimestamp('not-a-date'), 'Time unavailable');
});
