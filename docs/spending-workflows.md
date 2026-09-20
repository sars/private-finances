# Spending workspace: September 2026

Home opens the current Riga calendar month. Analytics opens 2026 to date and
supports date range, category, account owner, original currency and regular /
exceptional / unreviewed pattern filters. Display currency is a shared, persisted
header control; conversion still uses exact daily rates and records missing rates.
2025 stays in the ledger and can be explicitly opened as an archive. No source
transactions were deleted.

Review opens the previous calendar month, with separate current-month, older 2026,
and archive views. Search repeated merchant descriptions to review similar items.
The 3,000 UAH priority filter was retired on September 17, 2026 at the owner's
instruction; a large payment is reviewed like any other. Telegram automatic questions now
select only the current month; historical investigation stays in the app. Existing
sent messages are not erased, and manual Telegram queue actions remain available.

Historical estimates are a read-only projection of current cached suggestions and
specific MCC evidence. They never become confirmed spending or reusable rules.
Separate totals and breakdowns show estimates, unknown payments and missing rates.
Manual unresolved decisions remain unknown, not hidden. Large unclear transfers
remain reviewable; confident-looking model output cannot establish who received a
card transfer. Confidence scores are not calibrated probabilities.

Correspondence investigation is a one-time research task for 2026, removed from
the application at the owner's request. The owner will supply messenger exports
from their laptop. No personal message-history connection is required in the app.
Private research helpers and existing audit history are retained; payment-context
search UI and HTTP endpoints are removed.

Telegram receipt photos have their own private evidence workflow; see receipts.md.
They share the existing monthly AI maximum. Receipt evidence does not automatically
overwrite a manual category or split the purchase into item-level categories.

## Repeating one decision for later payments

A decision in Review can be saved as a confirmed rule in the same step. The
classify form offers **Apply this to future payments described exactly as "…"**,
and the match text is taken from the stored bank description rather than typed,
so an exact-match rule cannot drift from what the bank actually sends. This is
the supported way to record standing facts such as a recurring transfer whose
recipient is an account the household owns: classify it as an internal transfer
and tick the box. Bank-name evidence of that kind is not an account rule; a
registered account identifier still takes priority (see
[account rules](account-spending-rules.md)).

The rule is owner scoped, visible and disablable under Categories & rules, and
re-confirming a different decision for the same description replaces it instead
of leaving two rules that disagree. A payment with no bank description saves no
rule, because an empty matcher would claim every other descriptionless payment.
Matching payments are then classified without a Telegram question once
`AUTO_CATEGORIZE_CLEAR_EXPENSES` is enabled, including incoming ones, and each
application is recorded as `auto_classified` with the rule as its provenance.
Nothing generalises without the tick: one decision stays one decision.

A rule whose category no longer resolves to a real leaf does not silently swallow
the payments it matches. Triage treats a decision it cannot write as a question,
and migration 63 restored or retired the rules the category-tree migration had
left pointing at the root catch-all. See
[pending-payment triage](pending-payment-triage.md).

## From the overview banner to Review

The "there's more to the picture" banner links to Review with the needs-review
filter already selected and the window unrestricted, so every payment it counted
can actually be opened. The counts stay household-wide because the overview
reports the household, but Review only ever lists the signed-in owner's payments,
so the banner also says how many of the unresolved ones belong to the other owner
and can only be decided from that sign-in. An empty needs-review list explains
that settling payments keep their decision under All transactions rather than
implying the list is broken.

## Design basis

[YNAB Spending Trends](https://support.ynab.com/en_us/spending-trends-H1inlhzAc)
and [Lunch Money Trends](https://support.lunchmoney.app/home/trends) inform explicit
periods, category/merchant comparisons and recurring-spending controls. We adapt
those patterns to expense-only household analysis, showing coverage beside totals
rather than adding income, savings or unrelated generic KPI cards. Financial
correctness and uncertainty stay visible under every filter.

### Refunded payments in transaction browsing

Transactions hides a credit that is linked to a purchase as a refund, because that
money is already counted through the purchase. **Show linked refund credits**
restores them without changing bank records or reports. The purchase itself is
never hidden: it still needs its category and it shows what it finally cost.
Direct transaction links still open their target, and a link whose amounts no
longer agree with what it was made from brings its credit back. This filter
remains scoped to the signed-in owner and combines with the existing period and
review filters. See [refunds](refunds.md) for how a reduction is decided.

Unclear outgoing payments appear in **Needs review** while the bank processes them.
The **Bank processing** label describes settlement, not categorization: owners can
categorize these payments now. Financial reporting retains its booked-only review
predicate; this browsing change does not include pending amounts in reports.

See [pending-payment triage](pending-payment-triage.md) for automatic assessment,
Telegram questions before settlement and protection against duplicate questions.
