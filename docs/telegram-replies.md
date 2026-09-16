# Telegram review flow

Reply to a payment question with context in ordinary language. The application
uses the configured bounded AI model to read that answer, and then **saves the
decision**: the owner's own words are their decision, so they are not handed
back for a second confirmation.

The bot reacts 🙌 to the message it acted on and answers that same message with
what was saved — the payment, its type, its category, any tags — and a link to
the payment so a wrong answer can be corrected in one click. When nothing could
be saved it reacts 👀 and the reply says why.

## An answer that reaches nothing

That is the path for an answer the application accepted. An answer it never
accepted used to leave no trace at all. On 15 September 2026 two of Katya's
replies were consumed by the poller a couple of hours after the questions went
out; the cursor advanced, no proposal input was created, the two payments stayed
unresolved, and she was never told. Afterwards nobody could say which check had
rejected them, because the only thing kept was the update number.

`telegram_updates` now carries the `outcome` and a short `detail` for every
message a household member sends the bot, written inside the same transaction
that consumes it: which payment an accepted answer was linked to, or why a
discarded one reached nothing — that the message replied to is not an open
question, that the person answered a question addressed to the other member, or
that the payment moved on between the question and the answer. The poller also
writes a `telegram_reply_discarded` line to its log, so a lost answer shows up in
`journalctl` rather than only under inspection.

Note the shape of the most likely cause. A question is addressed to one member
and only that member's reply is matched to it, but the chat is shared, so either
of them may answer any question in it. Whether the other member's answer should
count is the owner's decision to make, and nothing here presumes it; the reason
is recorded so the next occurrence can be read rather than guessed at. Telling
the person in the chat that their answer did not land is still not implemented:
the outbox holds a question about a payment and has no way to carry a loose note.

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
