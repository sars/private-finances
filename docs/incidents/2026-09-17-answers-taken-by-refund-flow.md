# 2026-09-17: answers to Telegram questions were consumed by the refund flow

Status / severity / affected release: fixed in code, awaiting release / medium /
every release since refund questions shipped, up to and including 88c2034.
Impact on data and people: no data lost or changed in the ledger. Three answers
a household member gave the bot on 17 September 2026 about three of her
payments reached nothing: no proposal input was created, the payments stayed
unresolved, no line was logged, and nothing was said in the chat. The two
answers lost on 15 September 2026, then attributed to the owner mismatch fixed
at schema 44, most likely had the same cause.
Start, detection, recovery (UTC): the first lost answer was polled at 15:28 on
17 September, two more at 18:43 and 18:45; the owner reported "nothing
happened" the same evening; the fix is in PR (see below) and takes effect on
its release.
Evidence: `telegram_updates` rows 990967232, 990967234 and 990967235 with
`outcome IS NULL` and `detail IS NULL` and no matching `telegram_proposal_inputs`
row, while the three questions sit in `telegram_outbox` as `sent`. Two other
messages that evening (990967231, 990967233) were logged as
`telegram_reply_discarded … "ignored"` and never written: they were not replies
to a question.

Cause and factors: the worker offers every update to the refund questions,
the receipts and the suggestion workflow before the clarification consumer.
`RefundQuestions.receive` inserted the update number into `telegram_updates`
first and only then looked for a refund question to match; finding none it
returned `false`, but the row stayed, because all receivers share the poller's
transaction and a declined message is not rolled back. The clarification
consumer then found its own insert refused and returned `duplicate`, a result
the poller did not log and that never reaches the code that writes `outcome`
and `detail`. The outcome columns added at schema 43 to make lost answers
answerable were therefore bypassed by the very path that lost them. No test
ran `pollOnce` with the real chain of receivers.

Recovery and integrity check: the refund flow now looks up its question first
and consumes the update only when one matches. The poller logs every
non-accepted outcome, duplicates included, with the recorded detail. Every
message a household member sends the chat now leaves an outcome on its row,
including a plain message that is not a reply. A reply aimed at one of the
bot's own messages that reaches no open question, or whose payment has moved
on, is answered under that message with why, through a new `telegram_notes`
queue (schema 52), so a lost answer is never silent again. The three lost
answers themselves cannot be recovered: Telegram does not serve consumed
updates, and only their numbers were kept. The three questions are still open
in the chat and can be answered again once the release is live; the owner
named the two "Iнше" payments as the intercom fee in the meantime.

Regression test / PF-ID / PR: `test/reply-workflow.test.ts` "an answer polled
through every receiver reaches the question, not the refund flow" runs
`pollOnce` with the same receiver chain as the worker;
`test/refund-questions.test.ts` asserts a declined message leaves
`telegram_updates` untouched; `test/telegram.test.ts` covers the recorded
outcomes and the notes.

What to change, owner, status: done in code. Wider lesson: a consumer that
shares a transaction with the ones after it must not take a shared key before
it knows the message is its own, and the worker's real receiver chain needs a
test of its own, not only each receiver alone.

## Addendum, the same evening

With f97abac live the owner answered the Facebook question and again saw
nothing. This time the answer was accepted and linked, and the failure was one
step later: the model returned kind `non_personal` with a category for
"business, for advertising", `validate()` in `src/classifier.ts` rejected any
category beside a non-personal kind, and `processOne` set the workflow to
`failed` with no log line and no message. Two identical answers, two `failed`
rows, two measured model requests. Fixed by dropping the category for a
non-personal kind instead of failing, asking the model for null there, logging
`telegram_reply_failed` with the classifier's own code, and answering the
person under their message. Tests: `test/classifier.test.ts` "a category
beside a non-personal kind is dropped" and `test/reply-workflow.test.ts` "an
answer the model step cannot use is logged and answered".

## Second addendum, 18 September

With 4f19583 live all three answers were saved and confirmed, yet the owner saw
no reaction on his messages. Telegram refuses 🙌 from a bot with
`REACTION_INVALID` (bots may react only with a fixed set of emoji), and the
workflow swallowed the refusal, so the "applied" reaction had never landed
since it was introduced. A probe from the server confirmed 🙌 refused and 👍
accepted on the same message. The reaction is 👍 now and a refused one is
logged. The probe left a 👍 on the owner's Facebook answer.
