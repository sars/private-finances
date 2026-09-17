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

## Seeing what the imports did

The Bank imports screen (`/imports`, `frontend/src/Imports.tsx`) reads
`/api/imports`, built by `src/import-status.ts` from the importer's own record:
`bank_sync_runs` for each connection's state and last complete run,
`bank_import_windows` for how many payments each run changed and when, the
accounts each connection reaches with what they hold, and `bank_consents` for
how long the provider's approval lasts. It records nothing itself. A connection
whose scheduler has stopped shows as a last run growing old; the scheduler's
latch and cooldown files on the server are deliberately not read by the web
process. System health links here in place of the approvals form, which stays
on Bank connections.

## Balances

Both adapters now report what an account holds as well as what moved through it.
Monobank states it in the `client-info` response the account listing already
fetches, at no extra request. Enable Banking keeps balances behind
`GET /accounts/{uid}/balances`, one request per account per run; that is a
request but not another background fetch against the four-a-day allowance the
FAQ describes, which counts unattended polls. Both are best-effort in
`syncBank`: a refusal leaves the previous figure to go stale and never fails the
import. See [balances](balances.md).
