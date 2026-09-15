# Household browsing settings

Rodion is the application administrator. `/settings` and GET/POST `/api/settings`
require his authenticated login; the server rejects Kate even with a valid Kate
CSRF token. Saving also requires Rodion's CSRF token and current settings revision.
Changes are recorded in `app_settings_audit`. No credentials are managed here.

Both owners receive effective defaults through bootstrap and review APIs. Defaults
hide non-personal payments, classified internal transfers, credits linked to a
purchase as a refund, and payments that came to nothing. Investments remain
visible, and so does an ordinary personal payment made from a business account:
hiding follows the payment's own kind, never the account it sits on, in line with
how account purpose became a suggestion at schema version 25.

"Came to nothing" means the amount in the payment's own account currency, less
everything that came back — `refund.netMinor`, or the bank amount when there is no
refund — works out to zero. A purchase refunded in full is the usual case. A
reduction that disagrees with a later correction keeps its purchase listed even so,
because that discrepancy needs a person (ADR 0007).
These are browsing preferences only: bank records, classifications, reports, and
account authorization do not change. Suggested transfers remain visible.

Individual views override defaults with `includeNonPersonal`, `includeTransfers`,
`includeRefunds` and `includeZeroAmount`: `1` includes, `0` hides, omitted uses
household defaults. Direct
transaction IDs remain accessible only to their owner. `detailOnly=1&id=...` returns
only that owner's requested transaction, including when normally hidden.

Migration 17 adds a singleton settings record and an audit table. Existing databases
receive conservative defaults once; repeated migrations preserve saved settings.
Migration 38 renames `hide_business` to `hide_non_personal`, carrying the saved
choice across because the intent is the same, and adds `hide_zero_amount`,
defaulting to hidden. Audit rows written before it keep the old key names, as
history.

The review API accepts `display=UAH|EUR|USD|GBP` (default UAH) and returns scoped
`reporting.currency` plus converted rows with method/provenance or a missing-rate
reason. It uses the existing reporting conversion policy; original bank amounts are
unchanged. Detail-only responses also restrict proposals, triage and reply metadata
to the selected authorized record.
