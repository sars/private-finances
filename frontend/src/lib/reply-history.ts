export type SavedReply = {
  source?: 'telegram' | 'app';
  proposal?: unknown;
  proposal_id?: string | null;
  id: string;
  transaction_id: string;
  input_text: string;
  created_at?: string;
  status?: string;
  revision?: number;
  workflow_state?: string | null;
  transaction_description?: string;
};

/** Saved evidence and the processing outcome are separate, neither implies a new decision. */
export function replyHistoryStatus(
  reply: Pick<SavedReply, 'status' | 'workflow_state'>,
) {
  const input =
    reply.status === 'confirmed'
      ? 'Decision confirmed'
      : reply.status === 'rejected'
        ? 'Suggestion rejected'
        : 'Reply saved';
  const states: Record<string, string> = {
    processing: 'Interpreting your reply',
    waiting: 'Waiting for AI availability',
    ready: 'Suggestion ready',
    proposed: 'Suggestion ready',
    saved: 'Explanation saved',
    disabled: 'AI unavailable — explanation saved',
    budget_exhausted: 'AI budget unavailable — explanation saved',
    sending: 'Sending suggestion',
    sent: 'Awaiting your confirmation',
    confirmed: 'Decision confirmed',
    rejected: 'Suggestion rejected',
    stale: 'Payment changed — review again',
    failed: 'Could not interpret automatically',
    uncertain: 'Processing needs checking',
  };
  return {
    input,
    workflow: reply.workflow_state
      ? (states[reply.workflow_state] ?? 'Processing status unavailable')
      : reply.status === 'confirmed' || reply.status === 'rejected'
        ? 'Saved in your payment history'
        : 'Waiting to be processed',
    needsAttention: ['stale', 'failed', 'uncertain'].includes(
      reply.workflow_state ?? '',
    ),
  };
}
export function replyTimestamp(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Time unavailable';
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Riga',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' · Riga'
  );
}
export function repliesForTransaction(replies: SavedReply[], id: string) {
  return replies.filter((reply) => reply.transaction_id === id);
}
