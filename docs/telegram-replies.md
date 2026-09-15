# Telegram review flow

Reply to a payment question with context in ordinary language. The application
uses the configured bounded AI model to read that answer, and then **saves the
decision**: the owner's own words are their decision, so they are not handed
back for a second confirmation.

The bot reacts 🙌 to the message it acted on and answers that same message with
what was saved — the payment, its type, its category, any tags — and a link to
the payment so a wrong answer can be corrected in one click. When nothing could
be saved it reacts 👀 and the reply says why.

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
