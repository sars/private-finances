# One-time correspondence investigation

The owner removed this feature from the application on September 12, 2026.
There is no payment-context UI or HTTP endpoint. Existing audit history remains
preserved. The helper module below is retained only for the planned one-time
analysis of 2026 transactions after the owner provides messenger exports.

# Correspondence evidence

`CorrespondenceEvidenceStore` saves owner-supplied context in the existing
`audit_events` table under `correspondence_evidence_added`. It does not classify a
transaction, alter its revision or fetch the supplied reference. Supported sources
are Gmail, Telegram, WhatsApp, Viber, SMS and other. References are plain text up to
1,000 characters; summaries are plain text up to 2,000 characters.

Both reading and adding require the transaction owner. Adding requires the current
transaction revision. Each append has a unique audit ID, owner and timestamp; the
read projection marks evidence stale when the ledger revision changes. Notes are
not treated as verified instructions or automatically generalized to future payments.
Render note text as text, never as HTML. A reference is not necessarily a URL and
should not be automatically fetched or linked without separate URL validation.

`gmailEvidenceSearch` prepares a user-initiated Gmail search using the absolute
exact decimal bank amount and seven calendar days either side of the Riga payment
date. An optional narrower query includes sanitized description/counterparty/context
terms from the same transaction's safe details projection. It cannot determine which
Gmail account is signed in or whether any matching message exists. The generated
link opens Gmail's first signed-in account; users may need to switch accounts.

No connector access, scraping, outbound messages, LLM calls or new migration is
included. Integration must enforce the same owner access on API routes and display
these notes separately from confirmed classification decisions.

Validation: TypeScript and two synthetic tests passed, covering ownership, audit,
nonmutation, stale revisions, bounded input, exact currency decimals, Riga dates,
search-operator sanitization and mismatched detail IDs.
