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

## Part 1 — filling the gap without inventing a rate

The National Bank's published rate was considered and **rejected by the owner**:
it is an administrative reference, not a price anyone trades at. Monobank was
suggested instead. Two findings follow, and neither one fixes 26 October 2025.

### Monobank publishes no history

```
GET https://api.monobank.ua/bank/currency
  {"currencyCodeA":978,"currencyCodeB":980,"rateBuy":51.07,"rateSell":51.7706,...}
```

Real commercial buy and sell rates for 107 pairs, free, unauthenticated, in the
same buy/sell shape the PrivatBank archive already uses, rate-limited to one
request per five minutes. But the endpoint takes no date parameter and carries
only a current timestamp. There is no archive to query, so it cannot answer for
October 2025.

It is still worth storing **from now on**, as an independent second commercial
source recorded daily. That protects future days against another empty
PrivatBank response, and gives a genuine cross-check on the source already in
use. It does nothing for the existing gap.

### Monobank's real rates are already inside our own data

Every Monobank foreign purchase carries `amount` in the account currency
alongside `operationAmount` and `currencyCode`, and that pair is Monobank's own
commercial rate at the moment of the purchase. The ledger already holds a great
many of them:

| Pair | Days with a derivable rate | Payments |
| --- | ---: | ---: |
| EUR / UAH | 291 | 1,432 |
| USD / UAH | 176 | 238 |
| GBP / UAH | 15 | 82 |
| PLN / UAH | 14 | 41 |
| Others | 17 | 22 |

325 of the 372 needed days carry at least one derivable Monobank rate. This is a
real commercial rate from a bank the household actually uses, already in the
database, needing no new external dependency.

### But not on the day that needs it

On 26 October 2025 all six Monobank transactions are domestic UAH purchases
(currency code 980). Not one is cross-currency, so no rate can be derived. The
surrounding days 24–28 October carry no cross-currency Monobank payment either.

So for that specific date: PrivatBank published nothing, Monobank has no archive
to ask, and our own data holds no rate to derive. Every real source is empty.

### First, check a multi-bank commercial aggregator — not yet verified

The owner's direction is to look at an aggregator of real Ukrainian bank rates
before settling for anything derived. **This has not been checked; checking it
is the first step of this task.**

Two candidates, both publishing what banks actually quoted rather than a central
bank's reference number, and both carrying history:

- **Minfin** (`minfin.com.ua`) — cash and card rates per bank, years of history,
  an API with some endpoints behind a key.
- **Finance.ua** — the same idea, historical per-bank rates.

The banks to cover are **Monobank, PrivatBank, Alfa-Bank and A-Bank**
(`abank.ua` — confirm this is the bank the owner meant by "ababk"). Either take
a named bank's commercial rate, or **an average of the commercial rates** across
those banks for the day. An average is the more robust choice: it does not
depend on any single bank having published, and it is still a commercial number
throughout.

What the check has to answer, in order:

1. Does either aggregator expose historical daily rates without a paid key?
2. Do they hold **26 October 2025** specifically? That day was a Sunday, and most
   Ukrainian banks do not publish weekend cash rates, so the alternative source
   may have exactly the same hole. This is the question that decides the rest.
3. If the date is present, how many of the four banks published it, and is an
   average meaningful or is it one bank's number wearing a disguise?
4. What are the terms of use and the rate limits, and is the endpoint stable
   enough to sit in a nightly timer?

If the aggregator has the day, it becomes the second source and the gap closes
with a real commercial rate. Record it under its own source string with full
provenance — which aggregator, which banks, which date, retrieved when — and
slot it into the precedence list below. `docs/server-requirements.md` then
records that outbound dependency instead of Monobank's.

Only if the check comes back empty does the fallback below apply.

### Fallback if no source has the day: carry the last published rate forward

A published rate does not stop existing when the bank takes a day off — it stays
in force until a new one supersedes it. On 26 October 2025 the rate in force was
the one PrivatBank published on the 25th: 48.90 UAH per EUR. The 27th published
48.85, so the day's true value sits inside a 0.1% band either way.

This is deliberately **forward-carry only**, never backward. A rate published on
the 25th was genuinely in force on the 26th; the 27th's rate did not yet exist
and must never be applied to an earlier day.

Note that this contradicts a standing project rule — `docs/fx-policy.md` states
"there is no NBU or nearest-date fallback". That rule exists to prevent a
*silent* substitution. A carry-forward that keeps the originating date in its
provenance and renders as its own state on the status page is not silent. If the
owner prefers the stricter rule, the alternative is to leave the six payments
permanently unconverted and show them as "empty at source", which the page
already supports.

### Rules

0. Run the aggregator check above first. The carry-forward rules exist only for
   dates that survive it with nothing published anywhere.
1. Carry forward only when **every** source is empty for that date, and only
   from the most recent earlier date that has a usable commercial rate. Never
   interpolate, never average, never reach backward from a later day.
2. Store the carried quote with provenance naming both dates — the date it
   applies to and the date it was published — so the record never claims
   PrivatBank published something on a day it did not.
3. Never carry forward across an unbounded gap. Cap it at a small number of days
   (three is ample for a weekend or holiday); beyond that the date stays missing
   rather than inheriting a stale rate.
4. Add Monobank's live endpoint as a second daily commercial source, stored
   under its own source string with full provenance, so future empty days have
   somewhere real to fall back to.
5. **Make source precedence explicit.** Today `FxRates.list` orders by
   `as_of, source, base, target` and `latest()` re-sorts by source string, so
   selection is alphabetical by accident. Any second source name that sorts
   before `PrivatBank commercial midpoint` would silently displace it. Declare
   the order — PrivatBank commercial midpoint, then Monobank, then a carried
   rate last — and select on that list rather than on the alphabet. Prove it
   with a test that stores two sources for one date and asserts the winner.
6. Keep every other refusal intact: no fabricated rate, no interpolation, no
   silent substitution. A date with nothing to carry from stays missing.
7. `docs/fx-policy.md` must be rewritten where it forbids any fallback, not
   appended to.
8. `docs/server-requirements.md` must record the outbound dependency on
   `api.monobank.ua` alongside the existing `api.privatbank.ua`.

Applying this converts the six payments of 26 October 2025 and takes the ledger
to full coverage.

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
| Carried | No source published; the previous day's rate is in force | Lighter than covered, stated plainly |
| Empty at source | Nothing published and nothing to carry from | Neutral grey, stated, not an alarm |
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

- The aggregator check is answered in writing before any fallback is built, and
  its finding for 26 October 2025 is recorded either way.
- Once the gap is closed — by an aggregator rate if one exists, by a carried
  rate if not — the ledger reports zero unconverted transactions and the strip
  shows 372 of 372 days.
- Storing two sources for one date selects the PrivatBank commercial midpoint,
  proven by a test rather than by reading the code, and a carried rate never
  displaces a published one.
- A carried rate states both dates in its provenance, and a gap longer than the
  cap stays missing rather than inheriting a stale rate.
- A date neither source publishes still renders as missing, with its rows listed
  and excluded from every total, never counted as zero.
- The page holds no filters, no totals, no monthly table and no owner split.
- The response no longer carries the full ledger.
- `docs/fx-policy.md`, `docs/server-requirements.md` and `docs/STATUS.md` reflect
  the new fallback and the rebuilt page, with outdated claims replaced rather
  than appended to.
- Frontend work follows the `frontend-screen` skill and `frontend/DESIGN.md`;
  `scripts/check_frontend.py` in `pnpm check` is the gate.
