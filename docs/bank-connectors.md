# Bank connections

Enable Banking handles the banks listed in `src/connectors/banks.ts` — Wise,
Revolut, Swedbank and LHV; Monobank uses its direct personal API. An account may
hold several currencies, which a bank reports as the currency `XXX`; then only
each payment knows what it was settled in, and the account is not checked
against them. Each row of that table carries three spellings: the provider's
registered name, which the consent must match byte for byte ("LHV Pank"), our
lowercase slug for filenames and systemd instances (`lhv`), and the label the
owner knows the bank by ("LHV"), which names its accounts and appears on every
page. Adding another bank means a row in that table, a `bank_consents`
migration, a glyph and colour in `frontend/src/lib/account-visuals.ts`, and a
timer drop-in under `deploy/`; nothing else is spelled out per bank.
Adapters are read-only and require injected, fixed-host HTTP clients. Requests
have timeouts, response limits, no redirects and sanitized error codes.
Monobank clients must share a requester with a 60-second minimum interval per token.
Do not log request headers or provider payloads.

Production credentials live only in `/etc/private-finances/credentials`, never in
Git. See [credential setup and origins](credentials.md) for each provider's portal,
owner-specific application IDs and server file names. The earlier local
`~/.config/private-finances` path was a bootstrap location, not the production
store. A PEM authenticates the application; each owner's bank consent and session
are still required. Monobank uses a separate personal API token for each owner.

Adapters preserve account currency amounts as exact integer minor units and
mark holds/pending payments separately. Enable Banking calendar-day dates are
stored at UTC midnight with date precision metadata; this is not a known payment
time and must not be used to invent an intraday FX rate. Unsupported currency
exponents fail explicitly. Enable Banking imports require entry_reference;
transaction_id is not stable enough for deduplication. Identity is scoped to the
account. Missing stable IDs fail the batch and require investigation.

Live consent, scheduled imports and provider-detail storage are connected. See
[release status](STATUS.md) for verified coverage and [scheduling](scheduling.md)
for polling/backoff. Pending outflows are displayed separately from settled
spending, but can already be categorized and linked to receipts; see
[pending payment triage](pending-payment-triage.md).

References: https://enablebanking.com/docs/api/reference/ and
https://api.monobank.ua/docs/index.html (reviewed 2026-09-11).
