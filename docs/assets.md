# Household assets (PF-020)

What the household owns, counted on a date and valued in one currency, so the
total and its parts can be read month by month and year by year. This is the
spreadsheet the owner kept by hand, moved into the application: the same
model, the same history, and the manual work squeezed down to the figures
nobody can read for us.

Status, September 18, 2026: step one is deployed (release 1ef7b68, schema 51)
with the spreadsheet history loaded; steps two and four — feed links, the
bank, broker, exchange and wallet feeds, the last-Thursday job — are merged as
migration 54 and await release. The Telegram round is the remaining step. Automatic balances, the monthly Telegram round
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

## The screens

**Assets** (`/assets`, under Money) is the analytics view and reads only.
Four figures for the chosen date — everything, invested, liquid, and
everything denominated in hryvnia — each against the previous snapshot; a
chart of every snapshot date with a switch between three splits, invested
against not, hryvnia against other currencies, liquid against not, the
scale shown on the phone too and no figures printed on the bars; three
donuts for the chosen date with the same three splits; a donut of the seven
largest holdings and the rest, where tapping a slice or its legend entry
excludes that holding so the next largest appears, the exclusions kept in
the page address; and the holdings, grouped by the holding's group — a
holding without one under its kind — with a subtotal line per group, groups
collapsed until opened, a switch for the flat list, and a pencil on each row
that opens the holding's page. A zero-quantity holding is hidden unless
asked for, and so are retired holdings; **Only what I type** hides every
holding a feed fills. The date picker moves between snapshots.

**Snapshots** (`/assets/snapshots`) lists every snapshot date with its total,
invested, liquid and count, each linking to the Assets view of that day, and
holds the form for today: every holding that is typed by hand, both members',
with its previous figure and the day it was counted, and an input in the
holding's own currency shown as plain text — the currency is fixed per
holding. Fed holdings sit behind a checkbox, read-only, with their source.
Everything typed is saved with one button; a figure that is not a number is
refused before anything is sent.

**Holding** (`/assets/new`, `/assets/<id>`) is one holding's settings on a
page of its own: name, kind, unit, group, whose, maturity, the invested and
liquid flags, retired, note, and the feed with its reference. Choosing a bank
account fills the name, whose and unit from the account.

Accounts are named the same way wherever the application lists one —
member, bank, product, and the currency when the product does not say it:
"Rodion · Monobank · Iron UAH", "Katya · Wise · EUR" (`src/account-names.ts`,
sent as `displayName` by the holdings and balances APIs). Either member sees
and records the whole household's holdings; there is no per-member scope
here, only an optional owner label on a holding.

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

## Feeds: what fills itself

A holding may name the **feed** that fills it and a **reference** the feed
looks it up by; the edit dialog offers both. Four feeds exist:

| Feed                | Reference                                                                                       | What is written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bank balance        | an account from the Balances page (`source\|accountId`)                                         | the balance the bank last stated in the holding's currency, less the agreed overdraft the bank counts inside it; a balance older than three days or later than the day is skipped, by reason                                                                                                                                                                                                                                                                                                             |
| Interactive Brokers | a symbol, or `CASH` for the cash in the holding's currency                                      | the summary position (zero once it is gone from the statement) or the ending cash; each position's mark price in USD is stored as that day's price; a position with no holding yet gets one, shaped like the existing broker holdings                                                                                                                                                                                                                                                                    |
| Binance             | one asset symbol, or `TOTAL` on a USD holding                                                   | every Spot coin worth at least a dollar gets a holding of its own under the exchange's group, created when new and zeroed when gone, priced at the exchange's own last prices; dust below a dollar is left out. A `TOTAL` holding takes the dollar value of everything, but is skipped as superseded once per-coin holdings exist, so nothing is counted twice                                                                                                                                           |
| Wallet address      | a public BTC or ETH address, or a bitcoin wallet's extended public key (`zpub`, `ypub`, `xpub`) | the address's balance from a public ledger — mempool.space for bitcoin, a public JSON-RPC node for ethereum — with the coin's price from the exchange's open ticker. An extended key is the whole wallet: its receive and change addresses are derived on the server (`src/bitcoin-wallet.ts`, BIP32 over secp256k1 with BIP44/49/84 encoding, tested against the standards' vectors), looked up one by one and summed, stopping after twenty unused addresses in a row; the key never leaves the server |

Every feed is read-only, talks to one fixed host with a timeout, a size limit
and no redirects, and reduces failure to a code; one feed failing never stops
another. The bank feed reads what the sync runs already stored and calls no
bank, so the Assets screen offers it on demand as **Fill from banks**. The
others run only from the command line and the timer.

`node dist/src/holdings-snapshot-cli.js [YYYY-MM-DD] [--check]` is the
monthly job: it fills every fed holding for the day (today in Riga by default)
and prints one line per feed with counts and status codes, never a name, an
address or a figure. `--check` only tries the broker and exchange credentials
and prints a status word each, with the statement's shape — how many
positions, which cash currencies, which attribute names the cash rows carry,
which sections — and the exchange's asset count, never a figure. Cash is read
from "Ending Cash" or, failing that, "Ending Settled Cash"; when the query's
Cash Report carries only the base-currency summary, that row is the cash in
the base currency the statement's conversion rates name. Credentials are files in
`CREDENTIALS_DIRECTORY`, present or absent: `ibkr-flex-token` with
`ibkr-flex-query` (the Flex Web Service token and the Query ID of an Activity
Flex Query in XML with Open Positions at summary level — Symbol, Position,
Mark Price, Position Value, Currency, Asset Class, Level of Detail — and Cash
Report — Currency, Ending Cash, Level of Detail — over the last business day),
and `binance-api-key` with `binance-api-secret` (a read-only key, restricted
to the server's address). `ETH_RPC_URL` may point the ethereum lookup at
another public node; the default is publicnode's, which answers without a key
where the other well-known public nodes now demand one.

`private-finances-assets-snapshot.timer` fires every Thursday at 10:05
Europe/Riga and the service passes `--when=last-thursday`, so the job does its
work only when the following Thursday falls in the next month; a calendar
expression alone cannot say "the last Thursday" (25..31 misses a 30-day
month's). `Persistent=true` makes a missed firing run at the next boot. Install and
enable it like the other units:

```sh
sudo install -m 644 deploy/private-finances-assets-snapshot.service /etc/systemd/system/
sudo install -m 644 deploy/private-finances-assets-snapshot.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now private-finances-assets-snapshot.timer
sudo systemd-run --wait --pipe --collect --uid=private-finances \
  -p EnvironmentFile=/etc/private-finances/app.env -p EnvironmentFile=/etc/private-finances/sync.env \
  -p WorkingDirectory=/opt/private-finances/current \
  /usr/bin/node dist/src/holdings-snapshot-cli.js --check
```

Feed links can also arrive in the import document: a holding that already
exists is matched by name and only its `feed` and `feedRef` are set; nothing
else about it changes.

## What stays manual, and what follows

Manual: cash, the Ukrainian banks without a personal API (PrivatBank offers
only a business API and an open-banking API for licensed third parties),
payment services, bonds, the property, the businesses and the debts. A bond is
one holding per issue with its maturity date; the value is the purchase cost
carried forward until it is counted again.

Still to come, as its own increment: **the monthly round in Telegram.** The
job lists the holdings still needing a figure in the household chat; a reply
like "cash USD 9660" records it; a second nudge after two days; a holding
reaching its maturity date is announced. Movements between holdings — money
that left one and arrived in another — are proposed from matching changes and
confirmed with one tap, so a transfer is never read as a loss and a gain.

## Verification

`test/holding-valuation.test.ts` covers the exact arithmetic, price
precedence, carry-forward, retired holdings, totals by flag and the typed-
currency conversion; `test/holdings.test.ts` the migration, validation,
versions and the report; `test/holdings-http.test.ts` authentication, CSRF,
shared household access, stale revisions and display currencies over HTTP;
`test/holdings-import.test.ts` the document's shape and a repeat run that
changes nothing; `test/holding-feeds.test.ts` the Flex statement parser and
request flow, the exchange signing and valuation and the ledger lookups
against fake fetchers; `test/holding-fill.test.ts` the bank fill with
overdraft and staleness, the broker fill with sold and new positions, the
exchange and wallet fills, the full run and the linking document. Migration
51 adds three tables and touches nothing existing; migration 54 adds the two
feed columns.
