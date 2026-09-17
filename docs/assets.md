# Household assets (PF-020)

What the household owns, counted on a date and valued in one currency, so the
total and its parts can be read month by month and year by year. This is the
spreadsheet the owner kept by hand, moved into the application: the same
model, the same history, and the manual work squeezed down to the figures
nobody can read for us.

Status, September 17, 2026: step one is deployed as release 1ef7b68 at schema
51 and the spreadsheet history is loaded — the model, the screen, the import
and the daily-rate valuation. Automatic balances, the monthly Telegram round
and the brokerage, exchange and wallet feeds are the following steps, listed
at the end.

This repository is public. A holding's name and value describe the household's
money, so they live only in the database; this document, the code and the
tests speak of kinds, not of anything the household actually owns.

## The model

A **holding** is one thing with a value. It has a name, a kind (cash, bank
account, brokerage position, coin, bond, deposit, fund, real estate, business,
money owed to us, other), a **denomination** — the unit its quantity is counted
in, a currency code or a symbol that has a price — two flags, **invested** and
**liquid**, an optional member it belongs to, an optional group (the broker or
exchange several positions sit in), an optional maturity date for a bond or
deposit, a note, and a retired flag. Names are unique; a change carries the
holding's revision and a stale one is refused.

A **snapshot** is the quantity of a holding on a calendar date. Several
snapshots for the same holding and date are versions; the latest counts and
the earlier ones stay, so a corrected figure never erases the one it replaced.
A figure typed in another currency is converted at that day's price into the
denomination and stored beside what was typed, so the person's own figure is
kept. Between snapshots the last known quantity is **carried forward** — the
screen marks such a figure and names the day it comes from — and a retired
holding stops being carried after its last snapshot while keeping its history.

A **price** is USD for one unit of a symbol on a day. USD is the pivot for
everything: for the currencies the daily PrivatBank quotes already stored for
spending conversion are used (UAH per USD and UAH per EUR from the same source
and day give USD per UAH and USD per EUR), for funds, shares and coins a price
is stored per symbol and day, by hand for now and by feed later. A stored
price for the day wins over a bank cross rate; failing both, the most recent
of either within seven days stands in and is marked approximate; failing
that, the holding is **without a price** and is counted separately rather than
as zero. Rounding happens once, on the final figure in the display currency,
half away from zero; every intermediate value is an exact rational.

## The screen

`/assets`, under Money. Four figures for the chosen date — everything,
invested, liquid, and everything denominated in hryvnia — each against the
previous snapshot; a chart of every snapshot date split into invested and not
invested; and the holdings, one row each, with the quantity typed straight
into the row. Enter saves the figure for the chosen date; a currency picker
beside a money figure converts a number typed in another currency; a holding
with a symbol shows a price field for that day. The date picker moves between
snapshots, and **Snapshot today** starts a new one on today's Riga date,
showing every quantity as carried until it is counted again. Retired holdings
are hidden unless asked for. Either member sees and records the whole
household's holdings; there is no per-member scope here, only an optional
owner label on a holding.

The display currency is the workspace's, from the header control, defaulting
to UAH like every other screen; the owner's own figure is USD and the control
remembers the choice.

## Endpoints

- `GET /api/holdings?display=USD&at=YYYY-MM-DD` — the report: holdings valued
  on the date (the latest snapshot date when omitted), the totals, the totals
  of the snapshot before, and the series of every snapshot date for the chart.
- `POST /api/holdings` — create a holding, or change one with `id` and its
  `revision`. Form-encoded with the CSRF token, like every write.
- `POST /api/holding-snapshots` — record `amount` for `holdingId` on `asOf`,
  optionally in `currency`.
- `POST /api/asset-prices` — record `usdPerUnit` for `symbol` on `asOf`.

## Loading the spreadsheet's history

The owner's workbook holds twenty snapshot dates from November 2022 and a
rates sheet. `scripts/holdings_from_spreadsheet.py` reads the two sheets by
their layout — dates across the first row, one holding per row with its
currency and flags, a block of illiquid holdings below — and writes a JSON
document; an optional mapping file, kept outside Git, renames holdings, sets
kinds and groups and skips rows. `node dist/src/holdings-import-cli.js
<document.json>` loads it against the restricted `DATABASE_URL`: holdings are
matched by name and created when new, snapshots and prices that already exist
with the same figure are left alone, and a different figure becomes a new
version. Running it twice changes nothing; the output is counts only.

The document names the household's holdings. Produce it on the operator's
machine, copy it to the server for the run, and remove it afterwards. Nothing
of it is committed, and `scripts/check_repository.py` still guards the tree.

```sh
python3 -m pip install --user openpyxl
python3 scripts/holdings_from_spreadsheet.py ~/Downloads/Assets.xlsx /tmp/holdings.json \
  --mapping ~/.config/private-finances/holdings-mapping.json
scp /tmp/holdings.json radar:/tmp/holdings.json
ssh radar "chmod 644 /tmp/holdings.json && sudo -n systemd-run --wait --pipe --collect \
  --uid=private-finances -p EnvironmentFile=/etc/private-finances/app.env \
  -p WorkingDirectory=/opt/private-finances/current \
  /usr/bin/node dist/src/holdings-import-cli.js /tmp/holdings.json; rm -f /tmp/holdings.json"
rm /tmp/holdings.json
```

`systemd-run` reads the environment file the way the service does, so the
quoted `DATABASE_URL` arrives intact and the socket's peer authentication
sees the application user. Passing the value through `env` from a `grep` of
the file keeps the quotes and fails authentication.

The spreadsheet's own rates — units per USD on each snapshot date — are
imported as prices with the source `spreadsheet`, so the history is valued
exactly as the spreadsheet valued it. Dates after the import use the daily
bank quotes and whatever prices are recorded.

## What stays manual, and what follows

Manual for now: cash, the Ukrainian banks without a personal API (PrivatBank
offers only a business API and an open-banking API for licensed third
parties), payment services, bonds, the property, the businesses and the debts.
A bond is one holding per issue with its maturity date; the value is the
purchase cost carried forward until it is counted again.

The following steps, each its own increment:

1. **Automatic balances.** Keep the balance Monobank's client-info call
   already returns (less the credit limit) and add Enable Banking's balances
   call for Wise, Revolut, Swedbank and LHV; a job on the last Thursday of the
   month at 10:05 Riga creates the snapshot and fills every linked holding.
2. **The monthly round in Telegram.** The same job lists the holdings still
   needing a figure in the household chat; a reply like "cash USD 9660"
   records it; a second nudge after two days; a holding reaching its maturity
   date is announced. Movements between holdings — money that left one and
   arrived in another — are proposed from matching changes and confirmed with
   one tap, so a transfer is never read as a loss and a gain.
3. **Feeds.** Interactive Brokers through its Flex Web Service (positions with
   market value and cash), Binance Spot through a read-only key, BTC and ETH
   wallets by public address with a public price source. Each fills its
   holdings inside the same job.

## Verification

`test/holding-valuation.test.ts` covers the exact arithmetic, price
precedence, carry-forward, retired holdings, totals by flag and the typed-
currency conversion; `test/holdings.test.ts` the migration, validation,
versions and the report; `test/holdings-http.test.ts` authentication, CSRF,
shared household access, stale revisions and display currencies over HTTP;
`test/holdings-import.test.ts` the document's shape and a repeat run that
changes nothing. Migration 51 adds three tables and touches nothing existing.
