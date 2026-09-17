import { randomUUID } from 'node:crypto';
import type { Database, Executor, Row } from './database.js';
import {
  Classifier,
  initializeClassifier,
  type ClassificationProposal,
} from './classifier.js';
import {
  Categories,
  assignablePaths,
  type CategoryNode,
} from './categories.js';
import { Repository } from './repository.js';
import type { Owner } from './domain.js';
import {
  accountLine,
  queueTelegramNote,
  reviewLink,
  validateTelegramConfig,
  type TelegramConfig,
  type TelegramTransport,
} from './telegram.js';

/** The vocabulary the classifier may propose from. Only leaves qualify: a
 * parent is not assignable, so offering one would invite a proposal that the
 * ledger must then reject (ADR 0006). */
export function hierarchicalCategoryPaths(nodes: CategoryNode[]): string[] {
  return assignablePaths(nodes);
}
export async function initializeReplyWorkflow(tx: Executor): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(7482391)');
  await initializeClassifier(tx);
  await tx.query(
    'ALTER TABLE telegram_proposal_inputs DROP CONSTRAINT IF EXISTS telegram_proposal_inputs_status_check',
  );
  await tx.query(
    "ALTER TABLE telegram_proposal_inputs ADD CONSTRAINT telegram_proposal_inputs_status_check CHECK(status IN ('pending','confirmed','rejected'))",
  );
  await tx.query(`CREATE TABLE IF NOT EXISTS telegram_reply_workflows (
    id uuid PRIMARY KEY,input_id uuid NOT NULL UNIQUE REFERENCES telegram_proposal_inputs(id),
    transaction_id uuid NOT NULL REFERENCES transactions(id),revision integer NOT NULL,
    owner text NOT NULL CHECK(owner IN ('rodion','katya')),chat_id text NOT NULL,
    proposal_id uuid REFERENCES classifier_proposals(id),
    state text NOT NULL CHECK(state IN ('processing','waiting','ready','sending','sent','confirmed','rejected','stale','failed','uncertain')),
    lease_until timestamptz,retry_after timestamptz,message_id bigint,
    receipt_state text NOT NULL DEFAULT 'none' CHECK(receipt_state IN ('none','queued','sending','sent','uncertain')),
    receipt_lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chat_id,message_id)
  )`);
}
function record(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;
}
function positiveId(value: unknown): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}
/**
 * Add the tags a proposal named, on top of whatever the payment already
 * carries. A name the household has since removed is skipped rather than
 * recreated: the classifier proposes from the owner's list, it does not extend
 * it. Returns the names actually applied, which is what the reply reports.
 */
async function applyProposedTags(
  tx: Executor,
  transactionId: string,
  actor: Owner,
  names: string[],
): Promise<string[]> {
  if (!names.length) return [];
  const service = new Categories(scoped(tx));
  const available = await service.listTags();
  const wanted = available.filter((tag) =>
    names.some(
      (name) => name.toLocaleLowerCase() === tag.name.toLocaleLowerCase(),
    ),
  );
  if (!wanted.length) return [];
  const current = await service.tags(actor, transactionId);
  await service.setTags(actor, transactionId, [
    ...new Set([
      ...current.map((tag) => tag.id),
      ...wanted.map((tag) => tag.id),
    ]),
  ]);
  return wanted.map((tag) => tag.name);
}
/**
 * Why a payment was classified, naming the household member who explained it.
 *
 * Either of them may answer any question in the shared chat, so the person who
 * wrote the answer is not always the owner of the card. The payment is still
 * decided as its owner — that is who is allowed to decide it — so without this
 * the history would credit the wrong person.
 */
export function explanationReason(answeredBy: string, paymentOwner: string) {
  return answeredBy === paymentOwner
    ? 'Saved from the owner’s own explanation in Telegram'
    : `Saved from ${answeredBy}’s explanation in Telegram, answering for ${paymentOwner}`;
}

function scoped(db: Executor): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (action) => action(db),
    close: async () => {},
  };
}
export class TelegramReplyWorkflow {
  private readonly settings: TelegramConfig;
  constructor(
    readonly db: Database,
    settings: TelegramConfig,
    readonly transport: TelegramTransport,
    readonly classifierFor: (owner: Owner) => Promise<Classifier>,
  ) {
    this.settings = validateTelegramConfig(settings);
  }
  async processOne(): Promise<string> {
    const item = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7482401)');
      // An interrupted model request may already have consumed its reservation.
      // Keep it visible for review rather than spending again automatically.
      await tx.query(
        "UPDATE telegram_reply_workflows SET state='uncertain',lease_until=NULL WHERE chat_id=$1 AND state IN ('processing','sending') AND lease_until<now()",
        [this.settings.chatId],
      );
      const waiting = (
        await tx.query(
          `SELECT w.*,p.input_text,p.message_id AS input_message_id FROM telegram_reply_workflows w JOIN telegram_proposal_inputs p ON p.id=w.input_id
        WHERE w.chat_id=$1 AND w.state='waiting' AND w.retry_after<=now() ORDER BY w.created_at,w.id LIMIT 1 FOR UPDATE OF w`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (waiting) {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='processing',lease_until=now()+interval '60 seconds',retry_after=NULL WHERE id=$1",
          [waiting.id],
        );
        return waiting;
      }
      const input = (
        await tx.query(
          `SELECT p.id AS input_id,p.input_text,p.owner,p.message_id AS input_message_id,o.transaction_id,o.revision FROM telegram_proposal_inputs p
        JOIN telegram_outbox o ON o.id=p.outbox_id WHERE o.chat_id=$1 AND o.state='sent' AND NOT EXISTS(SELECT 1 FROM telegram_reply_workflows w WHERE w.input_id=p.id)
        ORDER BY p.created_at,p.id LIMIT 1`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!input) return null;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO telegram_reply_workflows(id,input_id,transaction_id,revision,owner,chat_id,state,lease_until) VALUES($1,$2,$3,$4,$5,$6,'processing',now()+interval '60 seconds')",
        [
          id,
          input.input_id,
          input.transaction_id,
          input.revision,
          input.owner,
          this.settings.chatId,
        ],
      );
      return { ...input, id };
    });
    if (!item) return 'idle';
    try {
      const model = await this.classifierFor(item.owner as Owner);
      const result = await model.propose(
        String(item.transaction_id),
        Number(item.revision),
        item.owner as Owner,
        String(item.input_text),
        `telegram:${item.input_id}`,
      );
      const state =
        result.status === 'proposed'
          ? 'ready'
          : ['disabled', 'budget_exhausted'].includes(result.status)
            ? 'waiting'
            : result.status === 'stale'
              ? 'stale'
              : 'failed';
      await this.db.query(
        `UPDATE telegram_reply_workflows SET state=$2,proposal_id=$3,lease_until=NULL,
        retry_after=CASE WHEN $2='waiting' THEN now()+interval '1 hour' ELSE NULL END WHERE id=$1 AND state='processing' AND lease_until>=now()`,
        [item.id, state, result.status === 'proposed' ? result.id : null],
      );
      if (state === 'failed')
        await this.answerFailed(
          item,
          result.status === 'failed'
            ? (result.reason ?? 'classifier_failed')
            : result.status,
        );
      return state;
    } catch (error) {
      await this.db.query(
        "UPDATE telegram_reply_workflows SET state='failed',lease_until=NULL WHERE id=$1 AND state='processing'",
        [item.id],
      );
      await this.answerFailed(
        item,
        error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      );
      return 'failed';
    }
  }
  /**
   * An answer the model step could not turn into a decision. Two of them on
   * 17 September 2026 left a `failed` row and nothing else: no log line and
   * nothing in the chat, so the person who answered saw "nothing happened".
   * The reason is logged (a code, never the answer or the provider's text)
   * and the person is told to decide the payment themselves.
   */
  private async answerFailed(item: Row, reason: string): Promise<void> {
    process.stdout.write(
      `${JSON.stringify({
        event: 'telegram_reply_failed',
        workflowId: String(item.id),
        transactionId: String(item.transaction_id),
        reason,
      })}\n`,
    );
    if (!positiveId(item.input_message_id)) return;
    await queueTelegramNote(
      this.db,
      this.settings.chatId,
      Number(item.input_message_id),
      `I could not turn this answer into a decision, so nothing was saved. Please decide the payment in Private Finances.${reviewLink(this.settings, String(item.transaction_id))}`,
    );
  }
  async dispatchOne(): Promise<string> {
    const item = await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE telegram_reply_workflows SET state='uncertain',lease_until=NULL WHERE chat_id=$1 AND state='sending' AND lease_until<now()",
        [this.settings.chatId],
      );
      const row = (
        await tx.query(
          `SELECT w.*,p.proposal,i.message_id AS input_message_id,coalesce(i.answered_by,i.owner) AS answered_by,
          t.description,t.owner AS current_owner,t.revision AS current_revision,t.kind AS current_kind,t.status AS current_status
        FROM telegram_reply_workflows w JOIN classifier_proposals p ON p.id=w.proposal_id
        JOIN telegram_proposal_inputs i ON i.id=w.input_id JOIN transactions t ON t.id=w.transaction_id
        WHERE w.chat_id=$1 AND w.state='ready' ORDER BY w.created_at,w.id LIMIT 1 FOR UPDATE OF w,t`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!row) return null;
      const human = (
        await tx.query(
          "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event='classified' LIMIT 1",
          [row.transaction_id],
        )
      ).rows.length;
      // The owner's own words are their decision, so it is applied rather than
      // offered back for a second confirmation. These guards are what make that
      // safe: the payment must still be theirs, unchanged, undecided by a
      // person, and the category must exist. A failure writes nothing and is
      // explained in the reply instead.
      if (
        row.owner !== row.current_owner ||
        Number(row.revision) !== Number(row.current_revision) ||
        row.current_kind !== 'unresolved' ||
        !['booked', 'pending'].includes(String(row.current_status)) ||
        human
      ) {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='stale',receipt_state='queued' WHERE id=$1",
          [row.id],
        );
        return { row, outcome: 'stale' as const };
      }
      const proposal = row.proposal as ClassificationProposal;
      const paths = hierarchicalCategoryPaths(
        await new Categories(scoped(tx)).listNodes(),
      );
      if (proposal.category && !paths.includes(proposal.category)) {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='stale',receipt_state='queued' WHERE id=$1",
          [row.id],
        );
        return { row, outcome: 'stale' as const };
      }
      await new Repository(scoped(tx)).classify(
        String(row.transaction_id),
        Number(row.revision),
        {
          kind: proposal.kind,
          category: proposal.category,
          // The payment is classified as its owner, because that is who may
          // decide it; the household member who actually wrote the answer is
          // named here so the payment's own history says so.
          reason: explanationReason(
            String(row.answered_by ?? row.owner),
            String(row.owner),
          ),
        },
        row.owner as Owner,
      );
      const applied = await applyProposedTags(
        tx,
        String(row.transaction_id),
        row.owner as Owner,
        proposal.tags ?? [],
      );
      await tx.query(
        "UPDATE telegram_reply_workflows SET state='confirmed',receipt_state='queued',lease_until=NULL WHERE id=$1",
        [row.id],
      );
      await tx.query(
        "UPDATE telegram_proposal_inputs SET status='confirmed' WHERE id=$1",
        [row.input_id],
      );
      return { row, outcome: 'applied' as const, tags: applied };
    });
    if (!item) return 'idle';
    // A reaction is a courtesy that must never hold up the decision, which is
    // already committed; the reply that follows carries the real answer. It is
    // 👍 because Telegram lets a bot react only with a fixed set of emoji: the
    // 🙌 used until 18 September 2026 was refused as REACTION_INVALID on every
    // saved answer, and the refusal was swallowed here, so nobody knew.
    if (positiveId(item.row.input_message_id))
      await this.transport
        .react(
          this.settings.chatId,
          Number(item.row.input_message_id),
          item.outcome === 'applied' ? '👍' : '👀',
        )
        .catch(() =>
          process.stdout.write(
            `${JSON.stringify({ event: 'telegram_reaction_failed', workflowId: String(item.row.id) })}\n`,
          ),
        );
    return item.outcome;
  }
  /**
   * What the owner's message resolved to, in their own chat. It names the
   * payment, what was saved against it and a way back to change it, because a
   * decision applied without being confirmed has to be visible and reversible.
   */
  private async receiptText(item: Row): Promise<string> {
    const link = reviewLink(this.settings, String(item.transaction_id));
    const account = accountLine(item.source, item.account_label);
    const payment =
      String(item.description ?? 'Payment').slice(0, 200) +
      (account ? `\nAccount: ${account}` : '');
    if (item.state !== 'confirmed')
      return (
        `${payment}\nNothing was saved. ` +
        (item.state === 'rejected'
          ? 'You rejected this suggestion, so the payment is unchanged.'
          : 'The payment changed, someone already decided it, or the suggested category no longer exists. Open it and decide there.') +
        link
      );
    const tags = (
      await new Categories(this.db).tags(
        item.owner as Owner,
        String(item.transaction_id),
      )
    ).map((tag) => tag.name);
    return (
      `${payment}\nSaved as ${String(item.current_kind).replaceAll('_', ' ')}` +
      `${item.current_category ? `\nCategory: ${item.current_category}` : ''}` +
      `${tags.length ? `\nTags: ${tags.join(', ')}` : ''}` +
      `\nChange it here if that is wrong.${link}`
    );
  }
  async dispatchReceiptOne(): Promise<'idle' | 'sent' | 'uncertain'> {
    const item = await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE telegram_reply_workflows SET receipt_state='uncertain',receipt_lease_until=NULL WHERE chat_id=$1 AND receipt_state='sending' AND receipt_lease_until<now()",
        [this.settings.chatId],
      );
      const row = (
        await tx.query(
          `SELECT w.*,i.message_id AS input_message_id,coalesce(i.answered_by,i.owner) AS answered_by,
          t.description,t.kind AS current_kind,t.category AS current_category,
          t.source,acc.label AS account_label
        FROM telegram_reply_workflows w JOIN telegram_proposal_inputs i ON i.id=w.input_id
        JOIN transactions t ON t.id=w.transaction_id
        LEFT JOIN own_accounts acc ON acc.owner=t.owner AND acc.source=t.source AND acc.account_id=t.account_id
        WHERE w.chat_id=$1 AND w.receipt_state='queued' ORDER BY w.created_at,w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
          [this.settings.chatId],
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        "UPDATE telegram_reply_workflows SET receipt_state='sending',receipt_lease_until=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return row;
    });
    if (!item) return 'idle';
    // The payment's owner leads the line, and when the other member answered it
    // says so, so the thread shows whose money it was and who explained it.
    const answeredBy = String(item.answered_by ?? item.owner);
    const who =
      answeredBy === String(item.owner)
        ? String(item.owner)
        : `${String(item.owner)} (answered by ${answeredBy})`;
    const message = `${who}: ${await this.receiptText(item)}`;
    try {
      // Answering the owner's own message keeps the thread readable; without a
      // recorded message to answer, it still has to be said, so it is sent.
      if (positiveId(item.input_message_id))
        await this.transport.reply(
          this.settings.chatId,
          Number(item.input_message_id),
          message,
        );
      else await this.transport.send(this.settings.chatId, message);
      const saved = await this.db.query(
        "UPDATE telegram_reply_workflows SET receipt_state='sent',receipt_lease_until=NULL WHERE id=$1 AND receipt_state='sending' AND receipt_lease_until>=now() RETURNING id",
        [item.id],
      );
      if (saved.rows.length) return 'sent';
    } catch {
      /* An uncertain receipt must not be repeated automatically. */
    }
    await this.db.query(
      "UPDATE telegram_reply_workflows SET receipt_state='uncertain',receipt_lease_until=NULL WHERE id=$1 AND receipt_state='sending'",
      [item.id],
    );
    return 'uncertain';
  }
  async receive(
    raw: unknown,
  ): Promise<
    'unmatched' | 'ignored' | 'duplicate' | 'stale' | 'confirmed' | 'rejected'
  > {
    const update = record(raw),
      message = record(update?.message),
      chat = record(message?.chat),
      from = record(message?.from),
      reply = record(message?.reply_to_message);
    if (
      !Number.isSafeInteger(update?.update_id) ||
      Number(update?.update_id) < 0 ||
      !Number.isSafeInteger(chat?.id) ||
      String(chat?.id) !== this.settings.chatId ||
      !Number.isSafeInteger(from?.id) ||
      Number(from?.id) <= 0 ||
      from?.is_bot === true ||
      !Number.isSafeInteger(reply?.message_id) ||
      Number(reply?.message_id) <= 0 ||
      typeof message?.text !== 'string'
    )
      return 'unmatched';
    const actor = (['rodion', 'katya'] as const).find(
      (o) => this.settings.userIds[o] === String(from!.id),
    );
    if (!actor) return 'unmatched';
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT * FROM telegram_reply_workflows WHERE chat_id=$1 AND message_id=$2 FOR UPDATE',
          [this.settings.chatId, reply!.message_id],
        )
      ).rows[0];
      if (!row) return 'unmatched';
      // Either member may answer for the household, here as well as when the
      // question was first asked; `actor` is only who spoke, not whose money.
      const action = String(message!.text).trim().toLowerCase();
      const inserted = await tx.query(
        'INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',
        [update!.update_id],
      );
      if (!inserted.rows.length) return 'duplicate';
      if (action !== 'confirm' && action !== 'reject') {
        // Anything else said to a suggestion is not a decision. It used to be
        // dropped without a trace; now the row says so and the member is told.
        await tx.query(
          "UPDATE telegram_updates SET outcome='ignored',detail=$2 WHERE update_id=$1",
          [
            update!.update_id,
            'a reply to a suggestion must be confirm or reject',
          ],
        );
        await queueTelegramNote(
          tx,
          this.settings.chatId,
          Number(message!.message_id),
          'This suggestion is only confirmed or rejected: reply “confirm” or “reject” to it, or decide the payment in Private Finances.',
        );
        return 'ignored';
      }
      if (['confirmed', 'rejected'].includes(String(row.state))) {
        await tx.query(
          "UPDATE telegram_updates SET outcome='ignored',detail='the suggestion was already decided' WHERE update_id=$1",
          [update!.update_id],
        );
        return 'duplicate';
      }
      if (row.state !== 'sent') {
        await tx.query(
          "UPDATE telegram_updates SET outcome='ignored',detail=$2 WHERE update_id=$1",
          [
            update!.update_id,
            `the suggestion is ${String(row.state)}, not open`,
          ],
        );
        return 'ignored';
      }
      // Hold hierarchy stable through category validation and the decision commit.
      await tx.query('SELECT pg_advisory_xact_lock(7482394)');
      const current = (
        await tx.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [
          row.transaction_id,
        ])
      ).rows[0];
      const human = (
        await tx.query(
          "SELECT 1 FROM audit_events WHERE transaction_id=$1 AND event='classified' LIMIT 1",
          [row.transaction_id],
        )
      ).rows.length;
      if (
        !current ||
        current.owner !== row.owner ||
        Number(current.revision) !== Number(row.revision) ||
        current.kind !== 'unresolved' ||
        !['booked', 'pending'].includes(String(current.status)) ||
        human
      ) {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='stale',receipt_state='queued' WHERE id=$1",
          [row.id],
        );
        return 'stale';
      }
      if (action === 'reject') {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='rejected',receipt_state='queued' WHERE id=$1",
          [row.id],
        );
        await tx.query(
          "UPDATE telegram_proposal_inputs SET status='rejected' WHERE id=$1",
          [row.input_id],
        );
        return 'rejected';
      }
      const saved = (
        await tx.query(
          "SELECT proposal FROM classifier_proposals WHERE id=$1 AND owner=$2 AND transaction_id=$3 AND revision=$4 AND state='proposed'",
          [row.proposal_id, row.owner, row.transaction_id, row.revision],
        )
      ).rows[0];
      if (!saved) return 'stale';
      const proposal = saved.proposal as ClassificationProposal;
      if (
        proposal.category &&
        !hierarchicalCategoryPaths(
          await new Categories(scoped(tx)).listNodes(),
        ).includes(proposal.category)
      ) {
        await tx.query(
          "UPDATE telegram_reply_workflows SET state='stale',receipt_state='queued' WHERE id=$1",
          [row.id],
        );
        return 'stale';
      }
      await new Repository(scoped(tx)).classify(
        String(row.transaction_id),
        Number(row.revision),
        {
          kind: proposal.kind,
          category: proposal.category,
          reason:
            actor === String(row.owner)
              ? 'Owner explicitly confirmed the AI proposal by replying to its Telegram message'
              : `${actor} explicitly confirmed the AI proposal in Telegram, answering for ${String(row.owner)}`,
        },
        row.owner as Owner,
      );
      await tx.query(
        "UPDATE telegram_reply_workflows SET state='confirmed',receipt_state='queued' WHERE id=$1",
        [row.id],
      );
      await tx.query(
        "UPDATE telegram_proposal_inputs SET status='confirmed' WHERE id=$1",
        [row.input_id],
      );
      return 'confirmed';
    });
  }
}
