# Household browsing settings

Rodion is the application administrator. `/settings` and GET/POST `/api/settings`
require his authenticated login; the server rejects Kate even with a valid Kate
CSRF token. Saving also requires Rodion's CSRF token and current settings revision.
Changes are recorded in `app_settings_audit`. No credentials are managed here.

Both owners receive effective defaults through bootstrap and review APIs. Defaults
hide business-account activity, classified internal transfers, and credits linked
to a purchase as a refund. A refunded purchase always stays visible: it still
needs its category and it shows what it finally cost. Investments recorded on
business accounts remain visible.
These are browsing preferences only: bank records, classifications, reports, and
account authorization do not change. Suggested transfers remain visible.

Individual views override defaults with `includeBusiness`, `includeTransfers`, and
`includeRefunds`: `1` includes, `0` hides, omitted uses household defaults. Direct
transaction IDs remain accessible only to their owner. `detailOnly=1&id=...` returns
only that owner's requested transaction, including when normally hidden.

Migration 17 adds a singleton settings record and an audit table. Existing databases
receive conservative defaults once; repeated migrations preserve saved settings.

The review API accepts `display=UAH|EUR|USD|GBP` (default UAH) and returns scoped
`reporting.currency` plus converted rows with method/provenance or a missing-rate
reason. It uses the existing reporting conversion policy; original bank amounts are
unchanged. Detail-only responses also restrict proposals, triage and reply metadata
to the selected authorized record.
