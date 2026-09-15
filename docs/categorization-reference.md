# Reviewed categorization reference

The private reference covers every imported row, grouped by merchant descriptor
and MCC for review, with individual direction, account purpose, date, amount and
available bank context retained. The original spreadsheet is evidence, not an
instruction source or an infallible label set. It is never imported as bank rows.

Each reference decision has a reason, provenance and one of: owner confirmed,
reviewed inference, ambiguous, incoming/not spending or bank pending. The last
three are explicit coverage states, not fabricated expense categories. Inferences
remain editable and must not be described as owner-confirmed truth.

A stable merchant-description hash assigns development versus held-out merchants.
Freeze the labels before comparing a changed policy. Repeated payments from the
same merchant stay in the same partition. Report owner-confirmed and inferred
results separately, and distinguish correct approvals, wrong approvals, unanswered
cases and safe abstentions. The pure `evaluateCategorization` utility calculates
aggregate precision and coverage without emitting bank data. A private held-out
comparison detects regressions; it is not proof of accuracy on unseen future data.

Do not report classifications copied from the reference back into the ledger as
an independent successful model evaluation. Measure policy changes against the
frozen baseline before applying reviewed corrections. Existing model responses can
be replayed without new API spend; this tests decision policy, not a fresh model.
Human overrides, pending records, refunds and account exclusions retain priority.

Private reference and per-payment application receipts belong in ignored `data/`
and server-private storage, not Git, fixtures, CI or general application logs.
Only synthetic evaluation cases and aggregate methodology belong in the repository.

## Receipt status and remaining scope

Telegram JPEG/PNG receipt ingestion, household matching and receipt-informed
transaction categorization are deployed. PDF/multi-page ingestion, priced item
extraction and category allocations remain planned; see [TODO](TODO.md) and
[receipt architecture](receipt-item-analytics.md). Ask for confirmation on
ambiguous matches. Do not duplicate bank imports or send files to an LLM without
bounded cost controls. Support original-file viewing, correction and deletion;
keep files private with the same owner access rules as the transaction.
