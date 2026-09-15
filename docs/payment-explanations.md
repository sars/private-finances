# Durable payment explanations

An owner can save up to 2,000 characters explaining their own transaction. The
application commits this text before requesting AI, so provider failures, missing
configuration and budget pauses do not discard it. Migration 18 adds
`transaction_explanations`; original bank records remain unchanged.

`PaymentExplanations.saveAndPropose(actor, {transactionId, revision, text,
requestId}, classifier?)` validates owner and bank revision, persists the input,
then optionally requests a proposal. `requestId` is a client-generated UUID, unique
per owner. Retrying the same input returns the existing result without another paid
request; changing a reused request's payload is a conflict. A crash after saving
leaves a visible processing record. It does not silently repeat a possibly paid
request. If a completed classifier proposal exists, history recovers it by its
`app:<explanation UUID>` request key.

The result and `list(actor, transactionId?)` expose `id`, `input_text`, `status`,
`created_at`, `transaction_id`, `revision`, `workflow_state`, `source: "app"`,
`transaction_description`, `proposal_id`, and `proposal` (or null). Inputs are
owner-scoped. They must never enter general application logs.

App-requested proposals may suggest corrections to already classified payments,
including human decisions, but do not apply anything automatically. Existing
account exclusions, inflow validation, shared model budget, schema validation and
transaction-revision guards still apply. Confirmation uses the existing explicit
classification action with the expected transaction revision. The model proposes
only kind/category/explanation; this does not infer tags, spending patterns or
item-level splits. Telegram and automatic proposal eligibility remain unchanged.

Synthetic tests cover save-before-request, concurrent duplicate submissions,
prompt isolation, paid-request deduplication, human decision preservation, failure
and disabled states, owner boundaries, stale revisions, and the migration upgrade.

`confirm(actor, {explanationId, transactionId, revision, kind, category, reason})`
atomically applies the owner's reviewed fields through the existing repository and
marks the explanation confirmed. The owner may edit the AI suggestion. Mismatched
owners, transactions, revisions or already-completed inputs cannot be confirmed.
History marks outdated pending inputs stale and retains confirmed input provenance.
Saved current-revision app inputs also block initial/triage AI requests and invalidate
in-flight automatic proposals; the explicit app proposal lane remains available.
