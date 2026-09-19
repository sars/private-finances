# Display currency and daily FX policy

The owner approved commercial buy/sell midpoints for historical display
conversion, from two sources and no others: **PrivatBank's own published rate**,
and, for the days PrivatBank publishes nothing, **the mean of the card rates
published by the household's own four banks** — Monobank, PrivatBank, Sens Bank
(Alfa) and A-Bank — read through Minfin. Both are prices people actually
trade at. Neither is the National Bank's reference rate, which the owner
rejected as an administrative number nobody trades on; it is never read, from
either source.

A verified transaction-specific bank amount always takes precedence over both.
Daily market conversions are estimates, including when the account bank is
neither of the two. They do not change transaction amounts, classifications or
reports in the original currency. Inflows and non-spending records remain
visible without being included in confirmed spending.

The public archive distinguishes PrivatBank `purchaseRate` / `saleRate` from NBU
`saleRateNB` / `purchaseRateNB`. Only the two commercial fields are used. The
midpoint is `(purchaseRate + saleRate) / 2`, expressed as UAH per one major unit of
the foreign currency. NBU-only entries remain unavailable. USD, EUR, GBP, JPY and
KWD are accepted only when both commercial fields exist; UAH is the conversion
pivot. Provider coverage can be narrower than this supported list.

There is still no NBU fallback, no nearest-date fallback, no interpolation and no
carried-forward rate. What there is instead is a **second commercial source for
the same day**. PrivatBank does not trade at weekends and publishes an empty
archive for them — 26 October 2025 was a Sunday, and eleven months of nightly
retries had already failed against it — so a second source asked about that same
date is not a substitution, it is another bank's answer to the same question.
A date neither source publishes stays missing, with its rows visible and
excluded from every total.

## What the status page measures

Every reporting currency at once — hryvnia, euro and dollars — never whichever
one the header happens to be showing. Conversion genuinely is per-target: a
hryvnia payment is already in hryvnia but needs a rate to become euro. A page
that answered for one currency could therefore read green while the ledger was
unconvertible in another, which is the one thing a status page must not do. The
worst currency leads, and a payment names the currencies it is missing from.

The page also lists the stored rate for each covered day, newest first, with the
source that would win that day. The coverage strip says a day has a rate; the
history says what it was.

## Source precedence

Selection order is declared, in `src/fx-sources.ts`, and is **not** alphabetical:

1. `PrivatBank commercial midpoint`
2. `Minfin household bank card midpoint`
3. `Minfin bank average midpoint` — **retired**, never written again

The third existed for one release. It came from scraping Minfin's rendered page,
which publishes only an average across every bank it tracks; the JSON the site
itself calls carries the per-bank breakdown, so the rate became the mean of the
household's own four banks instead. Quotes are immutable, so the rows already
written under that name stay where they are, outranked by everything above.

This matters more than it looks. The store used to order candidate quotes by
source string, so precedence was an accident of spelling — and `Minfin…` sorts
before `PrivatBank…`, which would have silently demoted the owner's approved
primary on every date both sources covered. A source nobody has ranked sorts
after both, so a name added later can never displace either by accident.
`test/fx-source-precedence.test.ts` stores both sources for one date and asserts
the winner, rather than leaving that to a reading of the code.

Response numbers retain their original decimal text. Midpoints and UAH cross
rates use integer/rational arithmetic; only the final converted minor amount is
rounded, halfway away from zero. A daily quote matches the transaction's UTC date.
Each stored quote retains its source, request URL, commercial buy/sell values,
as-of date, retrieval timestamp and immutable version. Corrections append versions.
Direct/inverse quotes take precedence over a same-source UAH cross rate; the latest
version of each source/pair/date wins, and where more than one source has stored a
quote for a date the declared precedence above decides, never the alphabet. Missing rows remain visible with a reason and
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
date. A day the primary archive returns empty is recorded as empty **at that source**,
in `daily_fx_absences`, and the secondary source is then asked about the same
date. A day both sources have answered "nothing" to is a closed fact and stops
being retried as if it might fill; a day neither has been asked about is still
outstanding. Those are different things, and the conversion status page draws
them differently — the first grey and silent, the second amber and actionable —
because a warning that is on permanently is a warning nobody reads.

A source that could not be *read* — a timeout, an HTTP error, a page whose layout
no longer matches — is not a source that published nothing. No absence is
recorded for it and the next run asks again.

A date already filled by either source is skipped on later runs, so neither
provider is asked nightly about a date that can no longer change.

The sync asks only about days that carry a payment, plus today. The status page
uses the same definition, so a calendar day with no payment on it is drawn as
needing nothing and left out of the coverage count. Counting those days against
the sync put two permanently amber cells on the page with nothing able to clear
them — the exact failure the two missing states exist to avoid.

## Sources

[PrivatBank/LiqPay archive documentation](https://www.liqpay.ua/en/doc/api/public/archive?tab=0),
reviewed September 12, 2026: the archive covers four years; JSON responses identify
the requested date, bank PB and base currency UAH, with separate commercial and
NBU fields. The midpoint is the owner's reporting policy, not a provider field.

Minfin's per-bank rates, read as JSON and checked 19 September 2026:

```
GET https://minfin.com.ua/api/currency/rates/banks/eur/?page=1&cpp=100&date=2025-10-26&commercial_sort=true
  {"data":[{"slug":"privatbank","cash":{...},"card":{"date":"2025-10-26T21:41:28+02:00","bid":"48.52","ask":"49.2611"}}, …]}
```

Free, unauthenticated, and dated back to 2006.

**This is an internal endpoint, not a published API.** `api.minfin.com.ua` is
the advertised product and needs a paid key; the URL above is what Minfin's own
rates page calls to draw itself. Nothing obliges them to keep it, and no
deprecation notice will arrive, so it should be treated as something that can
stop working on any given day rather than as a contract. Three things keep that
survivable:

- It is read at most a handful of times a year, only for days the primary source
  left empty, so the failure is rare by construction.
- A response that is not the expected envelope — a different shape, a bank quoted
  twice, a rate that is not a decimal, a sell below a buy — raises
  `invalid_response`. The day is reported unavailable rather than stored from a
  guess, and no absence is recorded for it, so the next run asks again.
- The day stays visible as missing on the conversion status page, with its
  payments listed. A source quietly disappearing shows up as an unconverted
  payment, never as a silently wrong total.

If it does go, the options are the paid key, a different aggregator, or leaving
the handful of affected days unconverted — which the application already handles
as its standing rule. Nothing about the primary source depends on it.

Four banks count, and no others: **monobank, privatbank, sensebank** (Sens Bank,
formerly Alfa-Bank) **and a-bank**. Their **card** rates are used, because the
spending being converted is card purchases and the card rate is what the bank
actually charged. The stored figure is the mean of each contributing bank's
buy/sell midpoint — the same number as the midpoint of the means, so nothing is
hidden in the choice — carried to six decimal places and rounded half away from
zero. The arithmetic is exact integer arithmetic until that last division.

A bank that published nothing usable for the day is left out rather than guessed
at, and the provenance names every bank that did contribute with its figures, so
a day carried by one bank reads as exactly that rather than hiding behind the
word "average". On 26 October 2025 three of the four published a euro card rate
(Sens Bank quoted none) and all four published a dollar one.

**Sterling has no secondary source.** Not one of the four quotes GBP, in cash or
on a card, so there is nothing of theirs to average; the twelve banks that do
quote it disagree by several hryvnia and the household holds no relationship with
any of them. A sterling payment on a day the primary source left empty therefore
stays missing and is listed, which is the standing rule rather than an exception
to it. Sterling was also withdrawn as a display currency: totals are reported in
hryvnia, euro or dollars. Payments *made* in sterling are unaffected and still
convert into whichever of those three is selected.
