# Receipt items and spending analytics — proposed architecture

Status: future design only, September 12, 2026. Related: PF-005/007
categorization, PF-006/011 receipt evidence and PF-010 reporting. The owner asked
us to save this plan, not implement item-level accounting yet. Immediate use of
attached receipt evidence for the existing transaction category is separate work.

## Product outcome

A payment remains one bank transaction, but its receipt can explain the basket:
coffee, dessert, groceries, household supplies or a refundable cup deposit.
Reporting should answer both “How much did we spend at restaurants?” and, where
there is sufficient receipt coverage, “How much of it was coffee?”. It must never
turn a vague receipt into invented purchase detail or count the payment twice.

For example, `Dzērieni` supports “Beverages”, not specifically coffee or beer.
`Depozīta glāze` supports a cup-deposit interpretation, not a drink purchase.
Repeated identical lines remain separate until quantities and amounts establish
whether they are separate items; text duplication alone is not deduplication.
The model may translate or normalize a label while preserving the printed text.

## Preserve three distinct layers

| Layer                | Owns                                                                                                                | Does not own                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Bank ledger          | Provider record, monetary amount/currency, owner, date, booking state, revisions                                    | OCR guesses or invented item prices                                  |
| Receipt evidence     | Original image, extracted fields and lines, confidence, extraction versions, attachment history                     | Authoritative bank totals or automatic proof of spending eligibility |
| Reporting allocation | Versioned assignment of an eligible payment's amount to categories/items, exact reconciliation, decision provenance | New bank transactions or edits to imported money                     |

Preserve the provider history and existing human decisions. Store receipt changes
as new evidence versions. Bank corrections invalidate stale proposals for review;
they do not silently overwrite confirmed allocations. A link says which payment
the receipt describes; it is not proof that the payment is personal spending.
Existing business-account, investment, transfer and refund rules retain priority.

Suggested future entities, names subject to implementation review:

- `receipt_extractions`: receipt ID, image hash, schema/model/prompt versions,
  normalized merchant/date/currency, printed totals, field confidence and cost ID.
- `receipt_lines`: stable extraction/line ID, original text, normalized label,
  quantity as exact decimal, unit, unit price, line total, discounts, tax treatment,
  line kind (purchase, deposit, discount, tip, fee, return, unknown), evidence
  location and classification provenance. Unknown values stay null.
- `receipt_links`: receipt/payment references, match evidence, actor and history.
  Keep the current one-payment attachment initially. Later support several
  receipts for one payment or split tender through explicit reconciled links;
  never assume a receipt total equals each payment in a split.
- `allocation_versions` and `allocation_lines`: payment revision, receipt/extraction
  revisions, category, bank-currency amount, receipt-currency amount where known,
  source, confidence, proposed/confirmed state and superseded version.

Separate “where” (merchant), “what” (item type), expense category and optional tags.
Coffee is an item type; dining is a spending category; routine/exceptional is a
separate decision. Do not create a category for every product or infer regularity
from a receipt alone.

## Processing and consistency

1. Persist the authorized photo before acknowledging Telegram. Deduplicate by
   update/file/content identity without collapsing legitimate repeated purchases.
2. Extract typed evidence once under the shared cost guard. Deterministic checks
   verify currency, amounts and printed arithmetic. A model does not perform the
   authoritative sum. Poor legibility becomes a visible uncertainty.
3. Match using the current shared-family mechanism. An unmatched photo remains
   queued for later bank imports; it does not cause another paid extraction.
4. Propose transaction classification from linked evidence now. In the later item
   phase, produce allocation proposals only after arithmetic reconciliation.
5. Apply a proposal with revision checks and audit history. A changed link,
   extraction, transaction or human decision makes stale work inapplicable.
6. Derive reports from one active allocation version per payment. Jobs are
   idempotent; retries cannot duplicate allocations or spending.

All amounts use currency-aware integer minor units; quantities use exact decimal.
Retain the printed net/gross/tax interpretation: VAT already included in prices is
not added again. Negative lines, basket discounts, tips, service charges and
rounding adjustments must each be represented once. Allocate basket-level
adjustments proportionally with a deterministic largest-remainder rule and stable
line-ID tie breaking. The allocated total must equal the eligible bank amount
exactly. An unexplained difference remains an explicit unallocated remainder;
do not silently spread it over items or label the basket fully reconciled.

For a receipt in a different currency, prefer the bank's exact original purchase
amount and currency. Allocate the actual bank debit proportionally across the
receipt's reconciled items, retaining both currencies and conversion provenance.
Separate an identified bank fee rather than adding it to coffee prices. If the
receipt and original purchase do not reconcile, hold detailed allocation for
review. Reporting FX remains the existing daily-rate layer; it must not masquerade
as a bank conversion or determine receipt matching. Any rounding in the display
currency must reconcile to that payment's converted total as well.

Refunds reference original purchases/items when known. Partial refunds reduce
only identified allocations; unknown refunds remain separately visible until
resolved. Refund amounts cannot exceed the linked eligible amount without a
visible exception. Preserve both purchase and refund dates; offer net cash spending
by posting period first, with any future purchase-period restatement explicit.

Deposits need an explicit owner-approved reporting policy before item accounting
ships. Proposed default: show paid/returned refundable deposits separately from
consumption, retaining them in cash-outflow reconciliation. A deposit is not free
money and must not disappear. A later refund closes or reduces the deposit; if it
cannot be linked, it remains an unmatched credit rather than assumed income.

## A small, understandable interface

Transaction details show the receipt thumbnail, extracted basket, category and
reason, with “From receipt”, “Estimated” or “Confirmed” labels. Keep the original
image/text available next to corrections. Mixed baskets get an optional “Split
by items” action, an exact remaining amount and bulk assignment of similar lines.
A simple restaurant purchase should require no item editing. Users can accept the
whole proposal, change a line, or retain the transaction's existing category.

Analytics keeps its existing spending total as the anchor. Offer category and
item views with merchant, owner, period and routine/exceptional filters. The item
view must show receipt coverage by value and by payment count, unallocated value
and estimates. Payments without receipts keep their transaction category and an
“Item detail unavailable” bucket; never exclude them silently. Drill-down totals
must agree with charts, including refunds, rounding and incomplete allocations.
No new component library is needed: use the existing shadcn/Tailwind/Recharts stack.

## Learning, access and cost

Human corrections have priority over rules and model output. Store who changed
what and why, plus the underlying evidence/version. Offer an explicit scoped rule
for repeated merchant/item labels; never generalize one correction silently to all
future payments. Merchant aliases require confirmation when identities differ.
Model suggestions use merchant, printed lines, MCC and existing knowledge together;
receipt text is untrusted input, never an instruction or tool permission.

Use deterministic normalization and confirmed rules before another model call.
Reuse the saved extraction; cache by content hash plus extraction/classification
version. A price or quantity change must not reuse an old monetary allocation.
Batch bounded text classification when useful; no automatic second vision call
for every match. Any quality retry is bounded, costed and stops on uncertainty.
Receipt extraction, item interpretation and existing AI features share the same
$10 monthly hard cap, reservations and dashboard usage ledger. Budget exhaustion
leaves evidence pending and preserves the working transaction view.

Keep images, receipt text and allocations private to the configured household.
Uploader provenance is retained; sharing a receipt does not widen generic payment
editing rights. Strip unnecessary identifiers before model requests where
practical, avoid receipt text in operational logs, and provide deletion/retention
controls with backup implications. Keep only non-content audit metadata after
requested evidence deletion; never delete a bank transaction with its receipt.

## Phases and acceptance criteria

1. **Now, separate implementation:** attached receipt evidence informs the existing
   transaction-category policy. Preserve human overrides and financial exclusions;
   uncertain evidence stays reviewable. Reattachment invalidates stale proposals.
2. **Later, extraction quality:** versioned priced lines and a private synthetic
   evaluation corpus: generic drinks, repeated lines, mixed baskets, tax-included
   totals, discounts, deposits and illegible text. Nulls beat invented detail.
   Compare printed totals and exact computed reconciliation, not only OCR text.
3. **Later, editable allocation:** optional item splits with exact totals, revision
   checks, owner approval and undo. Test partial refunds, foreign currencies,
   unknown fees, mixed payment methods and human corrections surviving reimport.
4. **Later, reporting:** item views with coverage and unallocated amounts. Verify
   category/item drill-down totals equal the same eligible payment total in every
   supported currency and period; no duplicate spend from multiple receipts.
5. **Later, learning and convenience:** explicitly approved recurring item rules,
   PDF/multi-page ingestion and retention controls. Expand auto-application only
   after measured accuracy on labeled examples and observed real corrections.

Before shipping phases 2–4, agree the deposit policy and treatment of mixed
personal/business baskets. No broad historical reprocessing or paid backfill is
implied by this plan. Migrations must preserve the current attachment and audit
records, be rollback-compatible, and include a restore comparison for new tables.
