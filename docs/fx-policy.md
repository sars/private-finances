# Display currency and daily FX policy

The owner approved PrivatBank commercial buy/sell midpoints for historical display
conversion. A verified transaction-specific bank amount always takes precedence.
Daily market conversions are estimates, including when the account bank is not
PrivatBank. They do not change transaction amounts, classifications or reports in
the original currency. Inflows and non-spending records remain visible without
being included in confirmed spending.

The public archive distinguishes PrivatBank `purchaseRate` / `saleRate` from NBU
`saleRateNB` / `purchaseRateNB`. Only the two commercial fields are used. The
midpoint is `(purchaseRate + saleRate) / 2`, expressed as UAH per one major unit of
the foreign currency. NBU-only entries remain unavailable; there is no NBU or
nearest-date fallback. USD, EUR, GBP, JPY and KWD are accepted only when both
commercial fields exist; UAH is the conversion pivot. Provider coverage can be
narrower than this supported list.

Response numbers retain their original decimal text. Midpoints and UAH cross
rates use integer/rational arithmetic; only the final converted minor amount is
rounded, halfway away from zero. A daily quote matches the transaction's UTC date.
Each stored quote retains its source, request URL, commercial buy/sell values,
as-of date, retrieval timestamp and immutable version. Corrections append versions.
Direct/inverse quotes take precedence over a same-source UAH cross rate; the latest
version of each source/pair/date wins, with stable source ordering when more than
one stored source is available. Missing rows remain visible with a reason and
are excluded from converted subtotals; coverage counts explain partial totals.

## Operator import

Use the restricted application's `DATABASE_URL` after its FX migration is applied:

```sh
# Distinct UTC transaction dates in the available four-year archive:
node dist/src/fx-sync-cli.js

# An explicit inclusive daily range:
node dist/src/fx-sync-cli.js 2025-09-12 2026-09-11

# Fetch already stored dates again and append quote versions:
node dist/src/fx-sync-cli.js 2025-09-12 2026-09-11 --refresh
```

The command uses the public API and requires no bank credentials. Explicit ranges
outside the last four calendar years or in the future are rejected. Default mode
only selects imported transaction dates within the archive; older transaction
rows continue to show missing conversion where no usable quote exists. Dates are
processed newest first, with at most 1,462 dates per run. Already stored provider
dates are skipped unless `--refresh` is supplied. Empty commercial responses are
reported as unavailable, not as a fabricated rate; they may be retried next run.

Requests have a 15-second timeout, a 128 KiB response limit, redirects disabled,
and at least two seconds between requested dates. Network failures, HTTP 429 and
5xx responses have at most three attempts, with bounded delays of at least two
seconds. Retry-After longer than 60 seconds stops the run instead of retrying too
early. A date's quotes are stored together; concurrent writes are serialized.
Progress contains dates and counts, never transaction amounts or account IDs.
The CLI itself does not install scheduling. Production uses the hardened
`private-finances-fx-sync.service` and `.timer`: daily at 05:00 UTC plus up to ten
minutes, after a successful local backup. The initial pass is resumable by stored
date. Missing archive days remain visible; the timer retries them on later runs.

## Source

[PrivatBank/LiqPay archive documentation](https://www.liqpay.ua/en/doc/api/public/archive?tab=0),
reviewed September 12, 2026: the archive covers four years; JSON responses identify
the requested date, bank PB and base currency UAH, with separate commercial and
NBU fields. The midpoint is the owner's reporting policy, not a provider field.
