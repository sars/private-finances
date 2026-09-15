# Historical classification evidence

On 2026-09-11 the owner identified the Claude Cowork conversation
“Річні витрати сім'ї”. Its visible six-message conversation was inspected directly.
Confirmed owner statements were separated from Claude's report and assumptions.

The private evidence file is stored outside Git and deployment releases:
`/var/lib/private-finances/knowledge/claude-family-expenses-2026-09-10.json`.
It contains source provenance, foreign-card ownership clues, investment and
family-transfer policies, a refund explanation and a scoped insurance repayment
correction. Financial identifiers, recipients and amounts are deliberately absent
from repository documentation and test fixtures.

Historical evidence is interpreted **locally**, never added to OpenAI prompts.
The original extraction remains an archive; the optional `HISTORICAL_KNOWLEDGE_FILE`
points to a separately curated runtime file. The Telegram triage worker loads it
at startup and uses exact matches before any paid model call. Matching suggestions
appear in Review with a previous-explanation label; they do not change the ledger.
Explicit saved rules and existing human decisions retain priority. Matching
conflicting evidence produces an unresolved suggestion, not an assumed answer.

Runtime schema: `schemaVersion: 1`, `entries` (maximum 100), each containing an
opaque `id`, `sourceReference`, `owner`, `kind` (`context` or `scoped_fact`),
`proposedKind` (investment/internal_transfer/non_personal/unresolved), a short
redacted `statement`, and `match`. Matching requires exact source, description,
currency and direction; account ID can further narrow it. Scoped facts also
require an exact integer `amountMinor` and inclusive UTC dates `from`/`to`.
Maximum file size is 64 KiB and permissions must exclude group/other access.
An explicitly configured missing or invalid file fails worker startup. No
configured file preserves existing behavior. More than three matches fail closed.
Evidence IDs and source references are persisted with the triage decision.

Deployed 2026-09-11 in release `b1897b4`, PR22. Runtime file:
`/etc/private-finances/historical-knowledge.json`, readable only by the service
account. One outgoing investment-recipient context is enabled. Current matching
recipient data is an inflow and was verified not to match; no current ledger
entries changed. Source archive remains root-private in the location above.

Production date coverage at extraction was August 11–September 10, 2026;
the July corrections cannot be matched until the relevant records are imported.
Card suffixes alone are not unique identifiers; do not create an own-account
match from four digits alone. A one-off repayment explanation must not become a
blanket rule for the recipient. Preserve unexplained differences rather than
inventing balancing transactions.

Claude's inferred account ownership, cash/tax exclusions, report totals and FX
calculations are not user-confirmed facts and were not imported as rules.
