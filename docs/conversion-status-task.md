# Task: rebuild the currency page as a conversion status (PF-009)

The `/fx` page currently answers "show me my spending in another currency".
Every other screen already does that, because the display currency is a global
setting. What the page should answer instead is one question the rest of the
application cannot: **is every transaction counted in the display currency, and
are the rates behind that up to date?**

The owner's framing: *"there should always be fine there. We just need to know
what's wrong."* The page is a status, not a report. It is green almost always,
and when it is not, it says exactly what is missing.

## Why the page needs the rate side too

Conversion can fail in two places, and only one of them is visible today.

The page currently shows the **symptom** — a transaction with no amount in the
display currency. The **cause** is a calendar day with no stored rate. One
missing day explains every unconverted payment booked that day.

More importantly, the rate side is the only thing that can show the nightly FX
sync is alive. Most recent spending is Monobank, which carries the bank's own
converted amount and needs no daily rate at all. If the sync died tonight,
nothing would go unconverted for weeks, and the breakage would surface long
after the fact. A "rates current through <date>" line catches it the next
morning. Nothing else in the application surfaces that failure.

## Measured starting point

Taken from production on 19 September 2026, so the implementation has a target
to check against. Counts only; no amounts belong in this public repository.

- 4,189 transactions in the ledger, across 13 months from September 2025.
- 4,183 have an amount in EUR. **6 do not.**
- All six are UAH payments booked on **26 October 2025**, reason
  `no_matching_quote`.
- Stored rate days: 371 for each of EUR/USD/GBP against UAH, covering
  11 September 2025 to 19 September 2026. Transactions need 372 distinct days.
  The one uncovered day is 26 October 2025.
- All three pairs are fetched in one call and always move together, so coverage
  is never partial within a day.
- Every stored quote is still version 1; no correction has ever been appended.
- Conversion method across the whole ledger: 2,576 daily estimate,
  1,432 bank-recorded, 175 already in the display currency, 6 none.

### The gap is empty at source, not unfetched

Confirmed by querying the provider directly:

```
GET https://api.privatbank.ua/p24api/exchange_rates?json&date=25.10.2025 -> full list
GET https://api.privatbank.ua/p24api/exchange_rates?json&date=26.10.2025 -> "exchangeRate":[]
GET https://api.privatbank.ua/p24api/exchange_rates?json&date=27.10.2025 -> full list
```

26 October 2025 was a Sunday, and PrivatBank published no commercial rates for
it. The sync retries unstored dates on every run, so eleven months of nightly
attempts have already failed against an empty archive. Retrying will not fix it.

## Part 1 — a second rate source for days the first one lacks

The owner asked: *"can we just add rate from another source?"* Yes. The National
Bank of Ukraine publishes that day.

```
GET https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=20251026&json
  EUR 48.5502   USD 41.897   GBP 55.8822   (exchangedate 26.10.2025)
```

For scale, the PrivatBank commercial midpoint was 48.90 on the 25th and 48.85 on
the 27th, so the NBU official rate sits roughly 0.7% below the commercial
midpoint. The owner has explicitly said this order of difference does not matter
to them. An official rate published for that exact date is preferable to
carrying a neighbouring day's commercial rate, because it keeps a real source
and date on the record rather than inventing a value for a day that has none.

### Rules

1. NBU is a **fallback**, never a replacement. Fetch and store an NBU quote only
   for a date where the PrivatBank commercial response carried no usable
   commercial pair. Where PrivatBank has data, nothing changes.
2. Store it in `daily_fx_rates` under its own source string, for example
   `NBU official rate`, with the same provenance discipline as the existing
   source: request URL, as-of date, retrieval timestamp, immutable version,
   corrections appended as new versions.
3. **Make source precedence explicit.** Today `FxRates.list` orders by
   `as_of, source, base, target` and `latest()` re-sorts by source string, so
   selection is alphabetical by accident. `NBU official rate` sorts *before*
   `PrivatBank commercial midpoint`, which would silently promote the fallback
   everywhere it existed. Add a declared precedence list — PrivatBank
   commercial midpoint first, NBU official second — and select on that instead
   of on the alphabet. Cover it with a test that stores both sources for one
   date and asserts the commercial rate wins.
4. Keep the existing refusals intact: no nearest-date fallback, no fabricated
   rate, no silent substitution. A date neither source publishes stays missing.
5. Both the CLI and the nightly timer use the fallback, so the backlog and new
   days are treated the same way.
6. `docs/fx-policy.md` currently states "NBU-only entries remain unavailable;
   there is no NBU or nearest-date fallback". That sentence is now wrong and
   must be rewritten, not appended to.
7. `docs/server-requirements.md` must record the new outbound dependency on
   `bank.gov.ua`, alongside the existing one on `api.privatbank.ua`.

Applying this should convert the six payments of 26 October 2025 and take the
ledger to full coverage.

## Part 2 — the page

Route stays `/fx` so existing links keep working. The navigation label and page
title become **Conversion status**.

### Remove

- The three total cards (personal spending, unresolved, pending). The owner does
  not want totals here; every other screen carries them.
- The entire filter bar: owner, period, currency, category, spending pattern,
  payment group, and the reset control.
- The search box, the pagination and the 50-row table of converted rows.
  Converted rows are fine and do not need showing.
- The monthly table, including the per-person rows. The owner does not want a
  month-by-month breakdown or a split between the two household members.
- Both explanatory paragraphs and the long page description.

### Section 1 — rates

One line, then one compact strip.

```
Rates current through 19 Sep 2026 · 371 of 372 days
```

The strip is one small cell per day, from the earliest transaction date to
today, wrapping with light month markers. Three states:

| State | Meaning | Treatment |
| --- | --- | --- |
| Covered | A usable quote is stored | Solid, unremarkable |
| Empty at source | Every source published nothing for that day | Neutral grey, stated, not an alarm |
| Not fetched | The sync has not reached this day yet | Amber, actionable |

The two missing states must be distinguished. A day the bank never published is
a closed fact and must not leave the page permanently amber; a day the sync has
not reached is a real problem the owner can act on. Conflating them produces a
warning that is always on, which is a warning nobody reads.

Each cell carries its date and state as an accessible label. No legend text
beyond the three state names.

### Section 2 — conversions

The status line, in the two shapes it can take:

```
All 4,189 transactions have a EUR amount
6 of 4,189 transactions have no EUR amount
```

Directly under it, one line of composition:

```
1,432 from the bank · 2,576 by daily rate · 175 already in EUR
```

This line is worth its space, although it never says anything is wrong. Almost
all bank-recorded figures come from Monobank's own converted amount. If that
field stopped arriving in the payload, every one of those payments would quietly
fall back to a daily estimate and no other part of the application would notice.
A visible composition makes that collapse obvious. Keep it to one line and do
not build it into cards.

### Section 3 — not converted

Rendered only when the count is above zero. Nothing at all when everything is
converted.

```
Date          Account         Amount        Why
26 Oct 2025   Monobank UAH    -450.00 UAH   No rate published for this day
```

The amount stays in its original currency, since by definition there is no
converted figure. `Why` is a plain sentence per reason, not the internal code:
`no_matching_quote` becomes "No rate published for this day",
`stale_transaction` becomes "Changed while loading — reload".

Show the account by the name the owner recognises, never the integration
provider's name. No pagination; if the list ever grows past roughly 200 rows,
cap it and state the true count.

### Counting must be consistent

The present page counts the month's daily estimates over booked rows only while
the total beside it includes pending ones, which is why the counter reads 50
where the month holds 53. Every count on the new page covers the same set of
rows. Pending payments are included throughout, because a hold is money the bank
has already taken.

### Scope

The status covers **every transaction**, not only personal spending. The current
monthly row counts personal expenses alone, which is why it reports 145 for
September rather than the month's full row count. The owner's ask is that all
transactions in the system are counted.

## Part 3 — the endpoint

`GET /api/fx` today returns every row in the ledger — 4,189 of them — and the
frontend then aggregates and discards nearly all of it. The new page needs
aggregates plus the handful of failures, so the response should shrink to:

- rate coverage: the needed date range, count of covered days, the latest stored
  quote date, and the per-day state list for the strip;
- conversion status: totals for all, converted and missing, plus the per-method
  counts;
- the unconverted rows only.

Keep the existing conversion code paths; this is a change of what the endpoint
returns, not of how a conversion is decided. The display currency continues to
come from the global setting.

## Acceptance

- With the NBU fallback applied, the ledger reports zero unconverted
  transactions and the strip shows 372 of 372 days.
- Storing both sources for one date selects the PrivatBank commercial midpoint,
  proven by a test rather than by reading the code.
- A date neither source publishes still renders as missing, with its rows listed
  and excluded from every total, never counted as zero.
- The page holds no filters, no totals, no monthly table and no owner split.
- The response no longer carries the full ledger.
- `docs/fx-policy.md`, `docs/server-requirements.md` and `docs/STATUS.md` reflect
  the new fallback and the rebuilt page, with outdated claims replaced rather
  than appended to.
- Frontend work follows the `frontend-screen` skill and `frontend/DESIGN.md`;
  `scripts/check_frontend.py` in `pnpm check` is the gate.
