# AI spending control

The household's monthly maximum is **USD 10**, shared across both owners,
dashboard requests and Telegram replies. Months follow **Europe/Riga**. The app
keeps **USD 0.50** unused as a safety buffer and admits a new request only when its
worst-case reservation fits within the remaining USD 9.50 operating allowance.
This controls this application's API calls, not unrelated usage of the OpenAI
account, taxes or provider invoice adjustments.

## Cost and reliability

Before sending a request, the app durably reserves its maximum priced cost under
a database lock shared across processes. It reserves the model's full input
context plus the configured output ceiling, then releases the unused portion
when valid usage arrives. It never relies on a character-to-token estimate to
protect the limit. Arithmetic uses integer billionths of a US dollar.

Reported input, cached input and output tokens determine tracked cost, including
responses that fail classification validation. Incomplete usage, a timeout or an
interrupted process retains the reservation: those requests may have been billed.
There is no automatic blind retry of an uncertain model call. Unknown model prices
fail closed. The existing daily request cap remains an additional safeguard.

Pricing was verified on September 11, 2026 against the official
[GPT-5.4 mini model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini):
standard API input USD 0.75, cached input USD 0.075, output USD 4.50 per million
tokens. The application uses the pinned 2026-03-17 snapshot, the standard service
tier and no paid tools. Each ledger entry preserves the applicable price snapshot.
These are calculated costs, not a reconciled provider invoice. Review prices
before changing the model; a provider price change requires an application update.

## Useful work within the budget

Human decisions and confirmed rules do not require an LLM request. AI sees only
bounded classification context, never complete account statements. Duplicate
requests for the same transaction revision/context are suppressed. Completed
suggestions are reused, while genuinely new owner replies can supply new context.
No more expensive model is selected automatically. When allowance runs out, bank
imports, reports and manual review keep working; Telegram interpretation waits
without spending until allowance is available.

Overview shows a compact household AI budget link. System health shows tracked
cost, reserved/uncertain amounts, available allowance, daily activity, model totals
and a pace-based forecast when enough history exists. The forecast is informative;
it never authorizes spending beyond the limit. Transactions filters do not change
the shared monthly AI allowance.

Earlier proposals did not record token usage. Migration 10 retains conservative
reservations for them in their original Riga month rather than displaying false
zero spending. They are identified separately from measured requests. No prompts,
transaction descriptions, replies or API keys are copied into the cost ledger.

## Deployment and recovery

Migration 10 must complete before starting the new classifier or Telegram worker.
Pause the worker during deployment and verify a fresh restore before resuming it.
Rolling back to older application code would remove the spending gate: disable AI
in both the web app and Telegram worker before such a rollback. Restoring an old
database may omit later billed calls; keep AI disabled until that usage is reconciled.

For the first deployment of this gate, stop Telegram and temporarily clear
`OPENAI_MODEL` in the protected server environment before switching releases. The
old release remains unable to spend if rollback is needed. After the new schema
and restore comparison pass, restore only the model setting (preserving the new
release SHA), restart the app and resume Telegram. Verify the budget endpoint and
both services before claiming the limit is active.

## Verified rollout — September 11, 2026

Release 522b830 is live after PR 20 and exact-head CI 34641322918 passed. Local and
server suites passed 106 tests (two PostgreSQL tests ran in CI). All 26 live tables
passed restore comparison. The authenticated endpoint reports budget $10, buffer $0.50,
Riga calendar and healthy state. Five earlier requests are legacy holds, not measured
charges. Both AI entry points resumed with the gate active.
