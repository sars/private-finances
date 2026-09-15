# Manual cash purchases

A cash entry records an actual purchase with amount, currency, purchase date and
what it was. `CashTransactions.create(actor, input)` accepts a positive decimal
**string**, an explicitly supported currency, a valid `YYYY-MM-DD` date, a nonempty
description and a UUID `requestId`. It returns `{ id, created }`. The authenticated
actor supplies ownership; callers cannot select a different owner in the input.

Amounts use the existing currency exponent registry and exact integer arithmetic.
Numbers/floats, exponent notation, zero/negative amounts and excess decimals are
rejected. No unknown currency assumes two decimals. Source is `manual_cash`;
`sourceId` is `<owner>:<requestId>`, and `accountId` is `cash:<owner>:<currency>`
because the existing account registry's key does not include owner. Each cash
account is explicitly personal through the audited Accounts service. An existing
non-personal account choice is preserved and prevents new purchases until the
owner reviews that choice.

Account creation/audit and `Repository.importBatch` commit together. Concurrent
retries return the same payment. Reusing the same request ID with a changed
amount, currency, date or description returns `cash_request_conflict` instead of
silently correcting a saved entry. Identical retries also preserve subsequent
classification and account decisions. Request IDs are scoped by owner, so one
member's request does not expose or block the other's payment.

The new payment is a booked debit, initially unresolved. A personal cash account
is not a claim that the purchase has a known category. Normal review,
classification, receipt attachment and reporting/FX apply to this ledger row.
The source records the actor, request ID, purchase date and `datePrecision: day`.
Date-only purchases use noon Europe/Riga as a storage convention, keeping the
purchase's calendar date identical for Riga reporting and the current UTC-indexed
FX lookup. This timestamp is not evidence of the actual purchase time; the UI
should display the purchase date.

## Withdrawals and corrections

Record spending when cash pays for a purchase, not when money is moved from a bank
account to a wallet. An ATM withdrawal is a transfer into cash, not an additional
purchase. The service never creates a matching withdrawal or changes existing
bank rows. Review any withdrawals already classified as personal expenses before
relying on combined cash/bank totals; they otherwise double-count the same money.
Withdrawals whose purpose is unknown remain visibly unresolved until reviewed.

Classification errors use the normal owner-authorized, audited classification
flow. Editing amounts/descriptions and deletion are outside this initial feature.
For an erroneous/duplicate cash entry, the owner can mark it excluded through the
existing classification flow with an explicit correction reason and then record
a replacement if needed; do not reuse an old request ID to alter evidence. There
is no silent deletion or automatic change to old withdrawal classifications.

Synthetic tests cover concurrent retries, cross-owner isolation, conflicting
payloads including currency changes, exact decimals including beyond JS's safe
integer range, Riga summer/winter date handling, rollback, preserved account
policy, and ordinary unresolved/classified reporting. No live banking or AI calls
are needed for cash creation. HTTP/UI integration is a separate coordinator step.
