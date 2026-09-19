# Telegram review flow

Reply to a payment question with context in ordinary language. The application
uses the configured bounded AI model to read that answer, and then **saves the
decision**: the owner's own words are their decision, so they are not handed
back for a second confirmation.

The bot reacts 👍 to the message it acted on and answers that same message with
what was saved — the payment, its type, its category, any tags — and a link to
the payment so a wrong answer can be corrected in one click. When nothing could
be saved it reacts 👀 and the reply says why.

## An answer that reaches nothing

That is the path for an answer the application accepted. An answer it never
accepted used to leave no trace at all. On 15 September 2026 two of Katya's
replies were consumed by the poller a couple of hours after the questions went
out; the cursor advanced, no proposal input was created, the two payments stayed
unresolved, and she was never told. On 17 September it happened again to three
of her answers, and this time the cause was found: the worker offers every
update to the refund questions, the receipts and the suggestion workflow before
the clarification consumer, all inside the poller's one transaction, and the
refund flow took the update number _before_ checking whether the reply was to
one of its questions. Its row stayed when it declined the message, so the
clarification consumer saw its own insert refused and treated the answer as a
duplicate — a result nothing logged. The write-up is
[the incident of 17 September](incidents/2026-09-17-answers-taken-by-refund-flow.md).

The refund flow now consumes an update only once a refund question matches it.
And every message a household member sends the chat now leaves a trace:
`telegram_updates` carries the `outcome` and a short `detail` for each one,
written inside the same transaction that consumes it — which payment an
accepted answer was linked to, or why a discarded one reached nothing: that it
was not a reply at all, that the message replied to is not an open question,
that a reply to a suggestion said something other than confirm or reject, or
that the payment moved on between the question and the answer. The poller
writes a `telegram_reply_discarded` line with that detail for every outcome
other than accepted, duplicates included, so a lost answer shows up in
`journalctl` rather than only under inspection.

The person is told as well. A reply aimed at one of the bot's own messages that
reaches no open question, or whose payment has moved on, gets a 👀 on it and an
answer under it saying so — with a link to the payment when there is one to
link — through the `telegram_notes` queue (schema 52), sent by the worker in
its next pass. A reply to a refund question addressed to the other member, or
to one already closed, is told that instead. A plain message in the chat, a
reply to the other member, a reply to a report or to one of these notes is
their own conversation: it is recorded and left alone, and a plain message is
not logged as a discarded reply either.

The model step can fail too, and that used to be the last silent path: on
17 September 2026 the owner answered the Facebook question twice with
"business, for advertising", the model answered non-personal _with_ a
category, the validator rejected the pair as invalid output, and the workflow
row went `failed` with no log line and nothing in the chat. A category beside a
non-personal kind is now dropped rather than refused — the kind is the
decision, and the schema had always allowed the pair — and the instructions
ask for null there. When the model step still fails, the worker logs
`telegram_reply_failed` with one of the classifier's own codes (never the
answer or the provider's text) and the person is told under their message to
decide the payment themselves, with the link. A failed answer is not retried;
answering again starts a fresh one.

The reaction itself was the last thing that "did nothing": until 18 September
2026 a saved answer drew 🙌, which Telegram refuses from a bot
(`REACTION_INVALID`; bots may use only a fixed set of emoji), and the refusal
was swallowed as a courtesy that must not block the decision. The saved
answer's reaction is 👍 now, and a refused reaction is logged as
`telegram_reaction_failed`.

Still open: each receiver takes the update number itself, so "match before
consume" is an invariant every receiver must uphold separately and the
clarification consumer is safe only because it runs last. Recording the update
once in the poller and handing each receiver the result would remove that
class of fault.

## What a question says

A question names the person, quotes the triage question or a generic one, and
gives the date, the amount, whether the bank is still processing it, and the
bank's description. Since 17 September 2026 it also names the account the
payment left, by the household's own label — `Account: black · Monobank`,
`Account: Wise EUR` — and, when the bank sent a merchant category code, what
that code means: `Bank category: Utilities — electricity, gas, water and
sanitation`. The reason is the pair of intercom fees whose only description
from the bank was "Iнше" (other): the person had nothing to go on, while the
code said utilities all along. The receipt that reports what was saved names
the account too.

### The name is a tag, not a word

The name a message opens with is a Telegram mention: it links to that person
and notifies them, so a question addressed to one member does not sit in a
shared chat waiting to be noticed. It travels as a `text_mention` entity
carrying the numeric user id from the chat binding, not as an `@username` —
neither member needs to have one, and a username someone later changes would
quietly stop tagging. The message itself stays plain text with no parse mode,
so a bank description full of `<` and `&` needs no escaping and cannot smuggle
markup into what the household reads.

Only a name the bot itself wrote is tagged. A question quotes the bank's own
description, and a description may read `TRANSFER-4 Sent money to Rodion
Salnik` — the bank naming a payee, not the bot addressing anyone — so the
search is anchored to the address at the head of the message and never sweeps
the quoted text. Tagged this way: the clarification question, the refund
question, the receipt reporting what was saved (both names, when the other
member answered), the notes that say a reply reached nothing, and the bank
approval reminder, which names the member whose approval it is. A report is a
bulletin rather than a message to a person, and stays untagged.

Untagged beats unsent, twice over. Telegram rejects a whole message over one
entity that does not fit its text, so a range that does not fit is dropped
before sending. And if Telegram refuses the mention itself — an id it cannot
resolve to someone it has seen — the message goes again without it: a 400 is a
refusal, nothing was delivered, so saying it once more cannot duplicate it. A
timeout is not a refusal and is never repeated; that send stays uncertain, as
it always has.

## Either member may answer, and the answer records who did

That was the most likely cause of the two lost answers: the question is
addressed to the owner of the card, and a reply used to be matched only against
questions addressed to the person who wrote it, so an answer from the other
member matched nothing. The owner settled it — "other members can answer and it
is fine. But better to record who answered."

So any household member may answer any question in the shared chat, and the
answer is applied exactly as if the addressee had written it. The chat is shared
because the household is the unit, and either of them may genuinely know what a
payment was for. The same now holds for confirming or rejecting a suggestion.

The two identities are kept apart rather than collapsed.
`telegram_proposal_inputs.owner` is whose payment the question was about;
`answered_by` is who typed the answer. The payment is still classified **as its
owner**, because that is who is allowed to decide it and the dashboard's
authorisation rests on it — widening that is a separate decision and was not
made here. What changes is that the person who explained it is named where it
matters: in the payment's own audit trail ("Saved from katya's explanation in
Telegram, answering for rodion"), in the reply history the dashboard shows, and
in the chat, where the confirmation reads `rodion (answered by katya):` instead
of just `rodion:`. When the owner answered their own question nothing extra is
said. Rows written before schema 44 have no `answered_by` and are read as having
been answered by the owner, which is what the old rule guaranteed.

Applying without asking is safe because of what is checked first, inside the
same transaction that writes the decision: the payment must still belong to
that owner, still be at the revision the answer was about, still be unresolved,
and carry no earlier human classification, and the suggested category must still
exist in the tree. If any of those fails nothing is written at all. Tags are
applied only from the household's own list, added to whatever the payment
already carries. It never creates a future category rule.

The decision is committed before anything is sent, so an unreachable chat can
never undo it; only the answer is left owed, and it is never sent twice.

A question that was already awaiting a typed **confirm** when this shipped can
still be confirmed that way, so nothing in flight was stranded.

AI requests are deduplicated per original reply and transaction revision and
share the application daily budget. Budget exhaustion waits for a later day.
Interrupted requests or uncertain message sends are retained for review instead
of silently spending/sending again. Owners can always use the dashboard Review
page when the model or Telegram is unavailable.

Migration 9 creates workflow state and adds a request key to classifier proposals.
Stop the previous Telegram worker during rollout, migrate, verify a fresh restore,
then start the new worker. The schema is additive, but new classifier code must
never run before the migration. Tests use synthetic inputs and mock Telegram/AI
transports; a real owner clarification and confirmed category were verified on September 12
through the saved workflow and the reported Telegram conversation (see STATUS).

Pending outgoing payments support the same owner reply flow.
The question can survive exact bank settlement; altered monetary or merchant
evidence still invalidates it. See [pending payment triage](pending-payment-triage.md).

## Saved explanation history

Accepted owner replies are persisted in telegram_proposal_inputs independently of
AI proposals and classification confirmation. A confirmed or rejected proposal
changes the reply's status; it must not remove the original wording. The review
API now returns all saved reply statuses, newest first, with the related workflow
state and transaction description. The Replies tab is history, not just the pending
queue. The separate pending() service method remains available for queue semantics.
Transaction-detail queries restrict replies to the selected authorized payment,
including explanations captured before a later classification revision.

The September 12 ticket-purchase report was a display bug: the explanation and
confirmed Entertainment outcome were already stored. No data reconstruction or
classification change was required. See STATUS for deployment verification.
