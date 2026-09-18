# Current state

Rewrite this section in place; do not append beside it. Everything below the
"Recent entries" heading is an append-only record of individual releases, and
older entries live in [the September archive](status-archive/2026-09.md).
Keep this file bounded: `python3 scripts/archive_status.py --keep 10` moves
older entries out. Run `scripts/deploy-status.sh` to compare the deployed
release with `origin/main` rather than reconstructing it by hand.

## Deployed release

**7858fa2ef1d0ecf6d29c35b4a6b99af2b99e6072**, live since September 18, 2026 at
schema version 57, deployed with `deploy/release.sh` in one run: 599
application tests passed on the server, the rehearsal on a restored copy
reached schema 57 with 4,171 transactions unchanged, both services active
afterwards. It carries PR #83: a snapshot made from the Snapshots page for
today reads the automatic figures first — the stored bank balances, the
broker, the exchange, the wallets, through the web process, one run at a
time and for today only — and then saves what was typed, so a snapshot is one
moment's picture; a second button reads the automatic figures alone. The web
process reads the feed credentials from `CREDENTIALS_DIRECTORY`, added to the
server configuration before the switch. A bank's rate-limit or transient
error now pauses its import for twelve hours instead of twenty-four, at the
owner's request. Bond maturity notices joined the to-do list.

The release before it, **483c965b2473506282f2899e9d6f533407b548b9**, is
described below.

**483c965b2473506282f2899e9d6f533407b548b9**, live since September 18, 2026 at
schema version 57, deployed with `deploy/release.sh` in one run: 599
application tests passed on the server, the rehearsal on a restored copy of
the real database reached schema 57 in 36 milliseconds with 4,171
transactions, 140 active refund links, no expense without a category and
nothing filed on a heading; both services active afterwards. It carries
PR #80, the owner's review of the assets round: the Balances total is own
money — every balance converted after the agreed overdraft is taken out, in
exact minor units — and the screen shows one figure per account and one
total with the explanatory text about limits gone; the Snapshots page lists
every date with Edit, which opens the same form for that day, and a confirmed
Remove backed by `POST /api/holding-snapshots/delete`, which deletes every
figure of a day and keeps the prices; the form's inputs are prefilled with
the day's figure, carried values included, and only changed rows are saved;
fed holdings stay read-only on any day; a Back to Assets link tops the
assets pages for the phone; and Assets links to both the list and a new
snapshot. Before this release the owner had the two unfinished snapshot days
of September 17 and 18 removed — 58 figures — so the latest snapshot is again
November 28, 2025 until the feeds run, on Thursday September 24 at 10:05
Riga or earlier on request.

The release before it, **c871c21f0f7086c1f1a115a1b960b9cbd97fcc6c**, is
described below.

**c871c21f0f7086c1f1a115a1b960b9cbd97fcc6c**, live since September 18, 2026 at
schema version 56, deployed with `deploy/release.sh` in one run: 593
application tests passed on the server, the rehearsal on a restored copy of the
real database reached schema 56 in 41 milliseconds with 4,171 transactions, 140
active refund links, no expense without a category and nothing filed on a
heading; after the switch both services are active and the import timers are
back. It carries PR #77 and adds no migration.

A message the bot addresses to a member now tags them. A question that opened
`Rodion,` named the person and nothing more: in a chat both members read, the
one it was for had to notice it. The name is a Telegram mention now — it links
to them and notifies them — sent as a `text_mention` entity carrying the
numeric user id the chat binding already holds, not an `@username`: neither
member needs one, and a username someone changes would quietly stop tagging.
Entities rather than HTML keep the message plain text, so a bank description
full of `<` and `&` needs no escaping and cannot smuggle markup into what the
household reads.

Only a name the bot itself wrote is tagged. A question quotes the bank's
description, and one may read `Sent money to Rodion Salnik` — the bank naming a
payee, not the bot addressing anyone — so the search is anchored to the address
at the head of the message and never sweeps the quoted text. Tagged: the
clarification question, the refund question, the receipt reporting what was
saved (both names when the other member answered), the notes that say a reply
reached nothing, and the bank approval reminder, which names the member whose
approval it is. A report is a bulletin rather than a message to a person, and
stays untagged.

The tag can never cost the message. An entity that would not fit its text is
dropped before sending, because Telegram rejects the whole message over one.
And if Telegram refuses the mention itself — an id it cannot resolve to someone
it has seen — the message goes again without it: a 400 is a refusal, nothing
was delivered, so saying it once more cannot duplicate it. A timeout is not a
refusal and is never repeated; that send stays uncertain, as it always has.
Without that fallback a refused tag would have failed the send, left the
question `uncertain`, and nothing retries an uncertain send.

The release before it, **858c9b2e6510fa905614f213ddaf96d9bae5abf7**, is
described below.

**858c9b2e6510fa905614f213ddaf96d9bae5abf7**, live since September 18, 2026 at
schema version 56, deployed with `deploy/release.sh` in one run: 588
application tests passed on the server, the rehearsal on a restored copy of
the real database reached schema 56 in 28 milliseconds with 4,171
transactions, 140 active refund links, no expense without a category and
nothing filed on a heading; after the switch both services are active and the
import timers are back. It carries PR #76, the owner's second round on the
household assets, built as four parallel pieces: Balances shows own money —
the stated balance less the agreed overdraft — and groups accounts into
Personal, Non-personal and Purpose to review; the Assets screen is read-only
analytics with a series switch, three composition donuts, a top-seven donut
with click-to-exclude and groups collapsed by default; a Snapshots page lists
every snapshot date and takes today's manual figures in one form; a holding
has a page of its own instead of a popup, with a bank account filling name,
member and unit; accounts are named by one rule everywhere ("Rodion ·
Monobank · Iron UAH"); and the IBKR Flex token's expiry is tracked beside the
OpenAI key's with the same 5, 2 and 1 day reminders, migration 56 widening
the reminders table's constraint. A route fix lets the pages under `/assets/`
load on a fresh visit: only a path with an extension is a bundle file.

Operator steps afterwards: `IBKR_FLEX_TOKEN_EXPIRES_AT` added to the server
configuration before the switch, so the restarted services read it; the 15
bank-fed holdings renamed to their accounts' names with prepared statements,
all 15 updated. Hand-typed holdings keep their spreadsheet names by the
owner's default.

The release before it, **9a77fc2b8b17901a0459f2590c555ffac4f620af**, is
described below.

**9a77fc2b8b17901a0459f2590c555ffac4f620af**, live since September 18, 2026 at
schema version 55, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 55 with 4,168 transactions unchanged, both services active.
Each member now signs in with an email address and a password, and the
session that follows can be ended (PF-021).

HTTP Basic authentication had the browser hold the password and re-send it on
every request. There was no way to sign out, the CSRF token was regenerated at
every restart — quietly invalidating open tabs — and nothing could ever
stand beside the password. Two tables replace it: `users`, one row per member with
an address and a scrypt hash, and `sessions`, holding the digest of a token
rather than the token itself, so a copy of the table resumes nothing. The
cookie is `HttpOnly`, `Secure` and `SameSite=Lax` — `Strict` is withheld on
the redirect back from bank approval, which would have dropped the member on
the sign-in screen mid-consent. Thirty days, sliding, renewed at most once a
day so a page view is not a database write.

Verified on the server after the switch: `/api/bootstrap` and
`/api/transactions` answer 401 without a session, the shell answers 200
because it _is_ the sign-in screen, both members sign in and receive their own
actor, and a wrong password is refused. `/health/ready` now answers without a
session as well — it carries no household data, listens on loopback and is
what `switch-release.py` polls, which no longer needs a password to deploy.

The environment still sets both passwords, applied at every boot, so rotation
stays edit-`app.env`-and-restart and remains the only way back in; nothing
resets a password by email. `RODION_EMAIL` and `KATYA_EMAIL` joined it for
this release and are required — without them the service refuses to start.
Guessing is delayed per address and per caller with no lockout, and an unknown
address is hashed against a decoy so it costs what a wrong password costs.

No library: Better Auth would have given sign-up, change-password, reset by
email, Google and a second factor as configuration, at about fifteen
dependencies in a server that has two, plus adapter work for the PGlite
databases the tests run on. None of those are wanted yet. The two tables are
shaped the way a library shapes them and every decision sits in `src/auth.ts`,
so the move later is two tables and one re-login. The trade and the three
routes on from here are in [authentication.md](authentication.md).

This release also carries the Prettier fix that had left the Tests workflow
failing on `main` since 12a20c4; `main` is green again.

**fc79952767963106906abd9c52ede6fbb19da24a**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 54 with 4,168 transactions unchanged, both services active.
The Add holding form can be scrolled to its own Save button again.

A dialog is fixed and the page behind it does not scroll, so one taller than
the screen cannot be reached at either end. The holding form has eleven
fields; on a phone its first field and its Save button both sat off-screen
with nothing to scroll to them. Accounts, Categories and the period picker
had all bound their own content with `max-h-[90dvh] overflow-y-auto` — the
holding dialog was the single call site that had not, which is why this was
the one screen the owner found stuck. The primitives come from the registry
and are never edited, so the bound belongs on the call, and
`scripts/check_frontend.py` now holds every `DialogContent` and
`SheetContent` to it instead of leaving the next one to remember. The rule
was confirmed to fail on the unfixed file before the fix went in.

The owner found this in the installed app rather than in Safari, where the
browser's chrome collapses on scroll and buys back the difference in height.

**12a20c496c8c9865b4d39eb09f4484b2ea372154**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 54 with 4,168 transactions unchanged, both services active. It
gives the installed app three things the browser's own chrome used to
provide, all of them owed to the release below that made standalone display
work in the first place.

The phone's tab bar is 3.5rem plus whatever the home indicator claims, and
that inset only became real when the viewport gained `viewport-fit=cover` —
so the flat `pb-20` reserved for the bar stopped covering it and the last
few millimetres of every screen sat underneath, which is how the owner found
it. The reservation now carries the same inset the bar does, restoring the
slack that existed before. `overscroll-behavior-y: none` is gone too: it had
taken pull to refresh away along with the rubber band, and an installed app
has no reload button, so that gesture is the only one the platform offers.
The per-screen refresh buttons stay — the gesture reloads the document and
loses the period, the filters and the scroll, while a button refetches and
keeps them, and a desktop has no gesture at all.

Nothing refetched on its own either: every query rests at `staleTime:
Infinity` with refetch on focus, reconnect and interval all off, so an app
iOS had suspended came back showing hours-old figures. Returning after more
than a minute away now invalidates everything but the session; under a
minute is switching to the bank's app and back, which should not cost a
round trip. Home, Reports and Cash read through raw `fetch` rather than the
query client and still refresh from their own button or the gesture.

Recorded late and out of order: **f83b6477289ec1161644525b1cb769180e1ee4ef**
(PR #71) went live between `e83193fd` and `56b8bbd4` and is contained in
both. Its commit message blames Safari for handing a click a bare `Text`
node, and that is wrong — the quirk is real but was fixed in WebKit around
2007, and modern Safari reports the element. The change is harmless
defensive code and was kept; what actually broke standalone display was the
manifest the policy refused, which `56b8bbd4` fixed.

**56b8bbd4170972fa862e3ad1cc2d5976e0065b70**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 54 with 4,168 transactions unchanged, both services active. It
replaces `f83b6477` (PR #71), which another session released during this
build and which this release contains. It carries PR #72: the installable app
stopped failing at the two files the browser fetches by itself. The response
policy named no `manifest-src`, and `default-src 'none'` is its fallback, so
the browser refused the manifest before requesting it; the policy now says
`manifest-src 'self'`. The service worker precached `index.html`, which the
server never serves under that path — screen routes answer with the shell and
`/index.html` is a 404 — so every install died with
`bad-precaching-response` and nothing was cached at all; no navigation is
served from the cache anyway, so `html` left the worker's glob patterns.
And the manifest link now carries `crossorigin="use-credentials"`, without
which the browser omits credentials and HTTP Basic authentication answers 401. `scripts/check_frontend.py` holds both properties against the built
output.

**e83193fd5acb0a7fd56abebeeecfa36d57200ed4**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 54 with 4,168 transactions unchanged, both services active. It
carries PR #69: the phone shell drops two website habits. The header's
hamburger opened the same sidebar the tab bar's own More button already
opens, and a closing footer bar (workspace name, a link to system health) sat
on top of the fixed tab bar — both are now `md:`-only, so the phone has one
navigation surface and one screen-end instead of two. `viewport-fit=cover`
and the `apple-mobile-web-app-capable`/`mobile-web-app-capable` meta tags let
iOS honour standalone display once the home-screen icon is re-added, the
header pads for `env(safe-area-inset-top)` to sit flush behind a notch
(mirroring the tab bar's existing bottom-safe-area padding), and
`overscroll-behavior-y: none` drops the browser's pull-to-refresh bounce.
Desktop is unaffected, having no tab bar to duplicate against.

**9d5d882a21c93ee8d2466d7ff32bc3bd74cf0ba4**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run: 583
application tests passed on the server, the rehearsal on a restored copy
reached schema 54 with the ledger unchanged, both services active. It carries
PR #67: every Binance Spot coin worth a dollar or more is a holding of its own
under the exchange's group, created by the feed and zeroed when gone, with a
total holding skipped as superseded; a bitcoin wallet is read from its
extended public key, the addresses derived on the server
(`src/bitcoin-wallet.ts`, tested against the BIP44/49/84 vectors) and looked
up on the public ledger with the twenty-address gap limit; and the Assets
screen groups rows with a subtotal per group, hides zero and fed holdings on
request, shows a fed figure read-only, and lost its Refresh button.

After the switch the owner's wallet key was linked to the Cold BTC holding —
it derives the funded address at receive index 0 and the empty one the wallet
had shown at index 1 — and the retired Binance total handed over to 21
per-coin holdings, which the snapshot run created and filled and which now
belong to the owner. The September 18 snapshot holds 14 bank balances, the
broker's 10 positions and cash, 21 exchange coins and both wallets; LHV alone
still waits for its bank's first stated balance. 114 holdings exist, 42 of
them retired.

**b22a37a080ad523b08b24847af3ca3a914e0a2ec**, live since September 18, 2026 at
schema version 54, the fifth release of the assets feeds that night, each
deployed with `deploy/release.sh` in one run with 579 application tests
passing on the server and the rehearsal on a restored copy reaching schema 54
with 4,165 transactions unchanged. `0e848955` (PR #64) reads the broker's
cash from the settled-cash field as well and made `--check` print the cash
rows' attribute names; that showed the live query's Cash Report carries only
the `BASE_SUMMARY` row, so `b22a37a0` (PR #65) reads that row as cash in the
account's base currency, which the statement's ConversionRates section names.
The Flex query itself stays as the owner saved it.

End state of the September 18 snapshot, counts confirmed in the database:
28 of the 29 fed holdings hold a figure — 14 bank balances, 10 broker
positions and the broker's cash, the exchange total and both wallets — with
168 prices stored from the broker and the exchange. The one without a figure
is LHV, whose bank has stated no balance yet under its rate limit; it fills
when an import stores one. Both credential checks answer `ok`. The timer next
fires on Thursday, September 24 at 10:05 Riga, the month's last Thursday, and
runs the same job. 93 holdings exist, 41 of them retired spreadsheet rows.
The Telegram round (AS-3) and the FOP's personal share from the company file
are the remaining assets work.

**cb3066a256ba1b028a94cc9c17bad4c3c4623d6d**, live since September 18, 2026 at
schema version 54, the third release of the assets feeds that night, each
deployed with `deploy/release.sh` in one run with 579 application tests
passing on the server and the rehearsal on a restored copy reaching schema 54
with 4,165 transactions unchanged. `4c17d471` (PR #62) made the timer fire
every Thursday with the job deciding whether it is the month's last, moved
the ethereum lookup to a public node that answers without a key, and dropped
zero exchange quotes; `cb3066a2` (PR #63) counts the broker's per-currency
cash rows, which are labelled "Currency", and made `--check` describe the
statement's shape. The timer is reinstalled from the release and next fires
on Thursday, September 24 at 10:05 Riga, which is the last Thursday.

With the owner's re-issued token both credentials answer `ok`. The snapshot
for September 18 holds 26 fed holdings: 13 bank balances, 10 broker
positions (two of them zero, sold since the spreadsheet), the exchange total
and both wallets, with 101 prices stored from the broker and the exchange.
Three fed holdings have no figure yet: LHV and Swedbank, whose banks have
stated no balance so far, and the broker's cash line — the statement's Cash
Report section carries no row this code could read, which the next release
diagnoses by printing the rows' attribute names and reads from the settled-
cash field as well.

**695378e28c6852d8b94350b603c50c0a8978f210**, live since September 18, 2026 at
schema version 54, deployed with `deploy/release.sh` in one run. It carries
the assets feeds (PR #61; see [assets](assets.md)): a holding names the feed
that fills it, and the bank, broker, exchange and wallet feeds with the
monthly job. Migration 54 adds two nullable columns to `holdings`; the
rehearsal on a restored copy of the real database reached schema 54 in 26
milliseconds with 4,165 transactions, 140 active refund links, no expense
without a category and nothing filed on a heading. On the server 579
application tests passed, 4 skipped; after the switch both services are
active and the seven import timers are back.

Afterwards the operator steps ran: the snapshot timer is installed and
enabled; the credential check answered `ok` for the exchange and
`auth:flex_1015` — "Token is invalid" — for the broker, which the owner is
re-issuing; the two link documents connected 14 broker, exchange and wallet
holdings and 14 bank holdings to their accounts and created a Wise GBP
holding; the retired Kate Mono EUR holding has no account behind it. The
first snapshot run filled 13 bank holdings from stored balances and one
wallet, and skipped the two accounts whose banks have stated no balance yet
(LHV and Swedbank). It also found three things the follow-up release fixes:
the timer's `25..31` calendar missed September's last Thursday, the 24th; the
default public ethereum node now demands a key, so the second wallet was
refused; and one exchange market quoted at zero made the exchange feed fail
on a price that cannot be stored.

The release before it, **872511b79eb289cea78e57ad79bedfd117c29118**, is
described below.

**872511b79eb289cea78e57ad79bedfd117c29118**, live since September 18, 2026 at
schema version 53, deployed with `deploy/release.sh`. It carries PR #59: the
reaction a saved Telegram answer receives is 👍, because Telegram accepts only
a fixed set of emoji from a bot and refused the 🙌 used since the flow shipped
with `REACTION_INVALID`; the refusal was swallowed as a courtesy, so with every
other path fixed the owner still saw "no reaction" on three answers that had
in fact been saved and confirmed. A probe from the server showed 🙌 refused
and 👍 accepted on the same message. A refused reaction is now logged as
`telegram_reaction_failed`. No migration: the rehearsal on a restored copy
reached schema 53 in 37 milliseconds with 4,165 transactions, 140 active
refund links, no expense without a category and nothing filed on a heading;
570 application tests passed on the server, 4 skipped. The release completed
in one run; after the switch both services are active, the seven import
timers are back, the Telegram worker restarted cleanly and the ledger holds
4,165 transactions. The Facebook question and the two "Iнше" questions from
17 September are answered and decided.

The release before it, **c6bf2f2b73b1bc4ff1434be2ade5bebfc3c77502**, went live
on September 18, 2026 at schema version 53. It changes one file
against the release before it — this document — and is recorded because the
running release must be one anybody can name. On the server 570 application
tests passed, 4 skipped; the rehearsal on a restored copy of the real database
reached schema 53 in 33 milliseconds with 4,165 transactions, 140 active refund
links, no expense without a category and nothing filed on a heading. After the
switch both services are active and the ledger holds 4,165 transactions.

A first attempt at this release, against **1e43ec5**, passed every gate and was
then refused at the last one: another session had switched to 4f19583 while it
built, and 1e43ec5 predated that, so switching would have withdrawn the Telegram
fix. The guard added on 17 September did exactly what it was put there for. The
commit was brought up to date and released again, which is the run above.

The release before it, **4f19583752d532842c41c78114260a1376bd08bb**, went live on September 18, 2026 at
schema version 53, deployed with `deploy/release.sh`. It carries two things.
PR #57 closes the last silent path for a Telegram answer: with f97abac live
the owner answered the Facebook question "business, for advertising" and again
saw nothing, because the model returned a non-personal kind with a category,
the validator refused the pair although the schema allowed it, and the
workflow row went `failed` with no log line and no message. A category beside
a non-personal kind is now dropped, a failed model step logs
`telegram_reply_failed` with the classifier's own code, and the person is told
under their message to decide the payment in the app, with the link. A failed
answer is not retried; answering again starts a fresh one. The release also
carries the Balances page (commit ac8df3a, merged to main without a pull
request; see [balances](balances.md)): every account's last stated balance
with its age, a household total at the daily rates, per-person card order, and
migration 53 with `account_balances` and `ui_layouts`. The rehearsal on a
restored copy of the real database reached schema 53 in 36 milliseconds with
4,165 transactions, 140 active refund links, no expense without a category and
nothing filed on a heading; on the server 561 application tests passed, 4
skipped. The release completed in one run; after the switch both services are
active, the seven import timers are back, the Telegram worker restarted
cleanly and the ledger holds 4,165 transactions. The Facebook question and
the two "Iнше" questions from 17 September are still open in the chat.

The release before it, **f97abac0338d062e21f94a16bd6094171fe51beb**, went live
on September 17, 2026 at schema version 52. It carries PR #54, the
fix for lost Telegram answers: on 17 September three answers a household
member gave the bot reached nothing because the refund-question receiver
consumed each update before checking it was its own, and the clarification
consumer then dropped the answer as a duplicate without a log line. The
receiver now consumes only what it matches; every household message leaves an
outcome on its `telegram_updates` row and the poller logs every outcome other
than accepted; a reply aimed at one of the bot's messages that reaches no open
question, or whose payment moved on, is answered under it with why through the
new `telegram_notes` queue; and each question and receipt names the payment's
account and the bank's merchant category. Migration 52 creates that one empty
table. The rehearsal on a restored copy of the real database reached schema 52
in 31 milliseconds with 4,165 transactions, 140 active refund links, no
expense without a category and nothing filed on a heading; on the server 559
application tests passed, 4 skipped. The first attempt stopped at "pausing
imports and the worker" because a Monobank import was running; the second run
completed once it had finished. After the switch both services are active,
the seven import timers are back, the Telegram worker started cleanly, the
ledger holds 4,165 transactions and `telegram_notes` exists and is empty.
The three questions from 17 September are still open in the chat and can be
answered again by either member; the two "Iнше" payments the owner named as
the intercom fee are unresolved until someone does. Details in
[the incident](incidents/2026-09-17-answers-taken-by-refund-flow.md) and
[Telegram replies](telegram-replies.md).

The release before it, **1ef7b68b790c84f9d9ad9653f580a7fe3ff8ac45**, went live
on September 17, 2026 at schema version 51, deployed by the owner. It carries
the household-assets increment (PR #51; see [assets](assets.md)): holdings
with dated, versioned snapshots, per-symbol prices, the `/assets` screen and
the spreadsheet import. Migration 51 adds three tables and touches nothing
existing; the rehearsal on a restored copy of the real database reached schema
51 in 72 milliseconds with 4,165 transactions, 140 active refund links, no
expense without a category and nothing filed on a heading. On the server 556
application tests passed, 4 skipped.

The first attempt stopped at "pausing imports and the worker": the LHV and
Monobank timers had fired at the moment the script reached that step and one
import outlasted the five-minute wait, so the script exited without switching
and left the timers and the Telegram worker stopped, as designed. The second
run, minutes later, found nothing running and completed. After the switch the
owner loaded the spreadsheet history with `holdings-import-cli` through
`systemd-run` with the application's environment file — 92 holdings, 1,202
snapshots over 21 dates and 188 prices, counts confirmed in the database. A
first attempt had passed `DATABASE_URL` through `env` from a `grep` of the
file, which kept the value's quotes and failed peer authentication; the
documented command now lets systemd parse the file.

The release before it, **2c30f679341d7002e70328d0a20430197fa9a0f3**, is
described below.

**2c30f679341d7002e70328d0a20430197fa9a0f3**, live since September 17, 2026 at
schema version 50, deployed with `deploy/release.sh`. Two fixes on Spending
analytics: the period picker is now the first labelled field of the filter bar,
at the same control height as the other filters and on its own row on the
phone; and the main column no longer widens the page when the heat grid is
wider than it (a month of days), so the grid scrolls inside its own card. The
second fix is in the app shell and applies to every page. No migration; both
services active after the switch.

The release before it, **88c2034d3a6efdc23f5abf95b601b4635e2ad749**, brought the
Account filter; its entry follows.

**88c2034d3a6efdc23f5abf95b601b4635e2ad749**, live since September 17, 2026 at
schema version 50, deployed with `deploy/release.sh`. Transactions and Review
gained an Account filter beside Whose, listing every account of the household
by the owner's own name for it; `/api/transactions` takes `account=<id>`. The
owner had reported not seeing the LHV payments: they were in both lists (the
live API returned both for the September Transactions query and for the Review
query), but the description search could not find an account. No migration;
both services active after the switch.

The release before it, **03539611ad6ef8663f575fd5d095c08df0b7eb97**, brought the
Bank imports page and renamed the LHV account; its entry follows.

**03539611ad6ef8663f575fd5d095c08df0b7eb97**, live since September 17, 2026 at
schema version 50, deployed with `deploy/release.sh`. It adds the Bank imports
page (`/imports`): one card per connection with its verdict, last complete run,
runs in 24 hours, payments changed over 7 and 30 days, the accounts it reaches
with what they hold, the approval and its remaining days, and the error advice,
then the forty most recent runs. System health links to it in place of the
approvals form. Migration 50 renamed the LHV account from the generated
"LHV <holder's name>" to `LHV` and marked it personal, as the owner said it is
the household's personal-expenses bank; a multi-currency account is now named
after the bank alone. Rehearsed on a restored copy first; both services active
after the switch.

State of the imports at this release, checked instance by instance:

- LHV: approved with country `EE`, first import at 18:22 Riga found the account
  and two payments; the bank serves history between two and six months only
  (a window from March 2026 is refused with 422) and enforces the PSD2
  allowance on unattended calls, so the `half-hourly` marker was removed and
  LHV runs every six hours. Measuring that window used up the day's allowance:
  the 19:23 Riga run answered `rate_limit`, which set the sticky conservative
  marker and a 24-hour cooldown, so the next LHV import is on September 18
  after 19:23 Riga. A one-shot backfill of 19 June to 17 August 2026 is
  scheduled on the server as the transient timer `pf-backfill-lhv-once` for
  September 18 at 19:45 Riga, after the regular import's cooldown; it stops
  the LHV timer, runs `backfill-cli`, and starts the timer again.
- Katya's Monobank: had been latched `review_required` since September 15 after
  one failed run whose cause the scheduler does not keep. Her token still
  answers, and the import ran cleanly against a restored copy (7 accounts, 28
  changes), so the latch was removed; the timer's next run succeeded at 18:29
  Riga and the two-day gap is inside the rolling window.
- Swedbank: on the six-hour cadence since a rate limit on September 16 set its
  sticky conservative marker; last success 13:34 Riga today.
- Wise (both), Revolut, Rodion's Monobank: succeeding every half hour.

LHV is still waiting on the owner: choose LHV on Bank connections (the country
now fills in as `EE`) and approve at the bank. The `enablebanking-rodion-lhv`
timer keeps ending `consent_pending` until then.

The releases before it, **ed4d96d5660b548dbd30a1f939a9a28703dcfb69** and
**a7ff4ba08008f2afc3dcc1f7c150d119312d3582**, are described below together with
the earlier releases of the day.

**a7ff4ba08008f2afc3dcc1f7c150d119312d3582**, live since September 17, 2026 at
schema version 48, deployed with `deploy/release.sh` as the fourteenth release
that day. It carries one fix (PR #43): the "Save explanation & suggest" button
on the review page did nothing because Base UI's Button renders
`type="button"`, so it never submitted its form; it and the demo import button
now say `type="submit"`, and `scripts/check_frontend.py` refuses a file whose
forms outnumber its submit buttons. No migration; rehearsed and verified as
usual, both services active, 4,140 transactions, no error in the log.

The release before it, **7359ae93ac9c11766754d8e11397db38a43ef604**, went live
on September 17, 2026 at schema version 48 as the thirteenth release
that day. It is `origin/main` after the Analytics rebuild (PR #40), LHV as a
bank reachable through the provider (PR #39, migration 48) and the status entry
for the eleventh release (PR #41). The migration was rehearsed on a restored
copy of the real database, reaching schema 48 with 4,140 transactions, 140
active refund links, no expense without a category and nothing filed on a
heading; after the switch both services were active and the log shows no error.

It was released to repair the twelfth release, **070aa5f3a64b7fdb81a15f40c664f3102b0b7703**
(the LHV merge alone), which for about ten minutes had withdrawn the Analytics
rebuild: the release script checked the running release only at its start,
another session switched to 46cdb02 during the twelve-minute build and
rehearsal, and the switch then went ahead against a release it had never
compared with. The script now reads the running release again immediately
before pausing imports and refuses under the same rule. Schema did not move
during the detour, both releases being at 48.

LHV is waiting on the owner. The provider registers the bank as "LHV Pank" for
Estonia (personal accounts, redirect approval, up to 180 days of consent,
marked beta on the provider's side); the application shows it as LHV and will
name its accounts "LHV EUR". The `enablebanking-rodion-lhv` timer is enabled
with the half-hourly drop-in and both markers, and every run so far ends as
`consent_pending` — no latch, no cooldown — until the owner approves access
from Bank connections with country `EE`, after which the first import follows
within thirty minutes. The owner was told in Telegram.

Before those, **46cdb02aef90831341cce4a2ea1c93a97568f6ae** was the eleventh release
that day, and **b947646947271a9fe9ea7aca51264b43640397b7** went live
on September 17, 2026 at schema version 47 as the tenth release that day. Its
two migrations (the Swedbank account is called `Swedbank`; an
explanation records who answered) were rehearsed first on a restored copy of the
real database, which reached schema 47 in 27 milliseconds with 4,140
transactions, 140 active refund links, no expense without a category and
nothing filed on a heading; the full suite passed on the server first (542
tests). After the switch both services were active, the ledger holds 4,140
transactions, the logs show no error and the Swedbank row reads `Swedbank`. It
carries the owner's first-look polish (PR #35), the rule that either member may
open and decide the other's payment in the app with the record naming who did
(PRs #36 and #37), and the refund filter that lists purchases rather than the
money back. See the entry below.

The release before it, **943f05ae213589ded422212ba2ec2098844e0f62**, went live
on September 17, 2026 at schema version 45 as the ninth release that day. Its
migration adds only indexes and was rehearsed first on a restored copy
of the real database, which reached schema 45 in 97 milliseconds with 4,139
transactions, 140 active refund links, no expense without a category and
nothing filed on a heading. After the switch both services were active, the
ledger still holds 4,139 transactions, the service logs show no error, and
the five new indexes exist. It carries the account badge (PR #29) and the four
steps that split Transactions into a review list, a transactions list and two
payment pages (PRs #30 to #33), described in
[the frontend plan](frontend-plan.md) and [performance](performance.md); the
3,000 UAH priority is retired everywhere. On the real ledger the review list
holds 422 outflows waiting for a decision: 155 on Rodion's accounts and 267 on
Katya's.

The release before it, **7a78a80e346c8ab111f05826d4c7687753c1a862**, went live
on September 17, 2026 at schema version 44 as the eighth release that day,
after `eedcc3260dc61ea2982f9161f72df708ba800797`,
`15eae42d2b5ff2d7301d62cf2f7ed75780c3538c`,
`2655695c3edb891c1dc0f0e9a4a987ffdb84163d`,
`69d91c219b2d0988027bf6b9cb7983257c26b375`,
`25e513dbedb7736c36785028ad851b11253d03dc`,
`393a3fa2dd98a01af471b1d66b93872fb94bb938` and
`ca7ca14ad7254a83dfa9eeb2f7a990ea4d0037b5`, which followed
`deab213944955ecbdccd7b10dc88de1113489c7d`. None of the eight carries a
migration: they are Stages 0 to 5 of [the frontend plan](frontend-plan.md) and
its closing fix —
Tremor's palette and self-hosted Inter, Recharts loading only on chart screens,
one money formatter, `scripts/check_frontend.py` in `pnpm check`; the
primitives on Base UI, the grouped sidebar with a phone tab bar and ⌘K, the
installable app, `Choice` for every pick-list; the finance vocabulary and Home
in the Tremor layout with previous-period deltas; `/api/analytics` with the
Analytics screen it feeds; Transactions as dense rows; every remaining screen
opening with the same header on the same card scale; the last hand-written
filters and tables gone, with historical estimates on the Analytics screen; and
every colour on a token, which the frontend check now enforces. After each
switch both services were active and the ledger holds 4,139 transactions.

The release before it, **deab213944955ecbdccd7b10dc88de1113489c7d**, went live on
September 16, 2026 at schema version 44 over
`b50918e354a05b080ae0f2dd8b384485c186c6cc`. Its migration was rehearsed first on
a restored copy of the real database, which reached schema 44 in 388
milliseconds with the transaction count unchanged, 140 refund links still
active, no expense without a category and nothing filed on a heading. After the
switch both `private-finances.service` and `private-finances-telegram.service`
are active, and the Telegram worker was watched past its first poll because a
schema change once killed it there.

Verified on the server afterwards: the Rimi shop and the H&M purchase the owner
found waiting on them are decided again and no longer provisional, by the model
and by an owner-confirmed rule respectively; two TEMPUSS FOTO payments moved to
Entertainment / Hobbies; twenty-four Wolt, Bolt Food and Glovo payments sit in
Food / Restaurants / Delivery while the two Glovo payments a person decided were
left alone; and the root catch-all fell from 237 personal expenses to 220. The
ledger still holds 4,139 transactions, no expense lacks a category and nothing
is filed on a heading. Read the entry below for what changed and why.

Note for whoever writes here next: this section had described release 840540 at
schema 38 while the server was running b50918e at schema 41, so three releases
had shipped without it being rewritten. `scripts/deploy-status.sh` compares the
deployed release with `origin/main` rather than reconstructing it by hand.

The three paragraphs that follow describe earlier releases in this line. The
first changes what the household browsing defaults hide. Its first
preference hid a payment for the account it sat on, which the application stopped
doing at schema 25, when account purpose became a suggestion and the payment's
own kind became the decision; it now hides payments classified `non_personal`
wherever they were paid from, so a personal payment on a business account stays
visible. The saved choice carried across the rename — the server shows all four
preferences on and no `hide_business` column left. The second preference is new
and hides a payment whose amount in its own account currency, less everything
that came back, is zero. On the server that is 273 non-personal payments and 79
purchases refunded in full; both sets return from one checkbox in Review, and a
reduction that disagrees with a later bank correction keeps its purchase listed
because that discrepancy needs a person.

Verified on the server afterwards: all seven merchants the owner named are
filed — car insurance 24,909.68 ₴, car repairs 22,894 ₴, padel 6,050 ₴, building
security 1,050 ₴, speeding fines 694.94 ₴, and the transfers now reading as
internal at 465 € across five payments. Exactly two rules exist from the batch,
both the transfer rule, one per member; none of the other six merchants left a
rule behind. Unspecified personal expenses fell from 324 to 300.

Two lessons from getting here are worth keeping. A migration that writes
household-specific data must be conditional on that data already being present,
or it seeds every fresh install and test fixture — this one put seven rules per
member into every database and broke thirteen tests before CI caught it. And a
local gate run as `pnpm check | tail` reports _tail's_ exit code, so it can
never fail; run it to a log and read `$?`.

This release closes a gap the owner found: a 12,543 UAH shoe purchase showed as
Unspecified in July yet never appeared in the review queue. The queue listed a
payment only while it was unresolved or provisional, so a payment a person had
classified was finished by that test whatever they classified it as — and the
move to the shared tree had mapped legacy paths with no successor (`Shopping`,
`Apps & services / AI tools`, `Other`) onto the root catch-all, flattening 291
decisions. 96 were still stranded there, worth 3,197 USD across a full year,
invisible to the one screen whose job is to find them.

The queue now lists anything filed on the root catch-all whoever decided it,
because a category naming nothing is unfinished work; a branch catch-all such as
`Food / Unspecified` still names its branch and is left alone. Schema 35 then
read the merchant category code back over the stranded payments and placed 80 of
the 96 — 30 Beauty / Cosmetics, 27 Clothes, 16 Apps & services, 6 Beauty /
Services, 1 Entertainment / Hobbies, verified on the server after the switch.
Unspecified fell from 407 personal expenses to 324, and all 324 are now reachable
from review. The remaining 16 stranded payments are six photo-shop charges, four
transfers to named people, three barber payments carrying no merchant code, two
marketplace orders and one advertising charge; they were left for the owner
rather than guessed at.

Historical reporting keeps the narrower test deliberately: those rows already
count as spending, so estimating them again would double count.

This line of three releases rebuilt the payment review page, let a suggestion
apply tags, and made an answer in Telegram a decision rather than a proposal.
`86c4886` rewrote `/review?id=…` around what identifies a payment: labelled
facts instead of bare words, day and clock time, an account chip, type-to-search
category and tag pickers, one combined decision, one refund block, and a
readable bank record over the collapsed complete field list. It also repaired a
category picker that had been silently empty because the screen read
`/api/categories` through a type the server never sent. `8f0d2f1` added tags to
the classifier's proposal as a closed enum of the household's own names, stopped
Telegram asking for a typed confirmation, and stopped the review page naming
Enable Banking, which is an aggregator the household does not bank with.

`8f0d2f1` also took the Telegram worker down for fourteen minutes. It reads a
`message_id` column that was added inside `initializeTelegram`, which only runs
in the one-time schema version 7 block, so no deployed database ever received
it; the worker exited a second after systemd started it, on every start. The web
application was unaffected and nothing was written incorrectly, because the
worker died before doing any work, and Telegram's own cursor was never advanced,
so queued messages drained once it was healthy. `8f45084` adds the column as
schema 34 and covers it in `test/migration-upgrade.test.ts` — the file that
exists because receipt columns were once lost exactly this way. Two habits
follow: a schema change needs its own version block, never an initializer, and
the deploy's `services: active active` check samples at switch time and cannot
see a crash on first poll.

Earlier releases in this line: schema 26 carried the shared category tree and
the refund model, schema 27 corrected refund matching, schema 28 introduced the
provisional resting place, schema 29 reconciled the tree, and schema 30
identified transfers by the counterparty the owner has stated rather than by
matching amounts (below), added receipts as evidence rather than a hold on the
totals, and corrected four merchants filed by name. An attempt on
September 14 switched to a commit older than the running release and was
corrected within minutes; see
[the incident note](incidents/2026-09-14-release-downgrade.md). `release.sh` now
refuses a target that does not contain the running release.

Refunds are working on real data: **140 active links**, covering 136 of the 138
merchant reversals in the ledger. The two that remain are unexplainable from
what we hold rather than undecided — a 45.00 EUR IKEA refund on Katya's card
whose purchase is on no account we sync, and a 6.00 EUR Riga parking reversal
with no charge at all. What the matcher still will not decide is recorded in
[refunds](refunds.md) rather than tracked here, so this section stays current
rather than growing.

## Live capabilities

Private Tailscale HTTPS deployment with per-owner authentication. Bank imports run
on enabled systemd timers for seven instances: Enable Banking `rodion-wise`,
`rodion-revolut`, `rodion-swedbank`, `katya-wise` and `rodion-lhv` (waiting on
the owner's approval), plus Monobank `rodion` and `katya`. Daily
commercial FX ingestion, household report delivery, Telegram clarification
questions with owner replies and confirmation, bounded AI categorization, and
receipt photos through the paired family Telegram chat are all working. Home and
Analytics use explicit periods and separately marked historical estimates. Unknown
transfers and incomplete bank coverage stay visible rather than hidden.

## Standing limits

The shared AI budget is a hard $10 monthly cap with reservation and settlement; it
is never raised to finish a task. Off-server encrypted backup to S3 remains
deferred at the owner's request: local restore works, and that is not off-server
protection. Automatic failure-triggered rollback is implemented but has never been
deliberately failure-injection tested. Monobank jars are excluded by choice. Income
analytics, live dashboard updates and 2025 deletion are outside scope. GitHub
branch protection is not enforced; reviewed PRs with green CI are a procedural
rule, not a server-enforced one.

## Recognising the household's own money

A transfer between the household's own accounts is identified from an IBAN when
a provider states one, from a masked card number when the payment names a card
the owner has identified, and otherwise from what the owner has said about the
counterparty by name (migration 30, `src/counterparty-identity.ts`).

The honest shape of this is worth keeping in view. Only about a third of
transfers carry a counterparty IBAN, and just 38 payments in the whole ledger
name a card — 22 of those cards appear once, being strangers paid once. The name
path therefore carries the work, and it holds only what the owner has stated:
their own classification rules, which is also where a decision they make by
hand now lands — categorising a transfer writes a rule, so it answers every
later payment to the same person whatever spelling the bank uses, and it is
visible and editable wherever rules are. A separate store held this briefly at
schema 30 and 31; the owner asked why a second mechanism existed when rules
already did the job, and schema 32 folded it back in.

An earlier version also matched by amount, pairing a payment with the same sum
arriving on another of our accounts. It was removed at the owner's instruction
because the system does not hold every account of the household — Kate has cards
at banks it never sees — so the other half of a real transfer is often absent
and a pair that does appear may be coincidence.

Run the recognition section of
[`scripts/category-diagnosis.sql`](../scripts/category-diagnosis.sql) to see how
far it reaches: how many counterparties are remembered and from where, and how
many transfers still counted as spending have a counterparty that recurs — those
are the ones where categorising once stops the repeats. Its four invariants must
all read zero.

## Known deviations

Two findings from the September 13 inspection, both recorded rather than silently
changed. The deployment user `radar` has unrestricted passwordless sudo, which
contradicts the restriction described in [the deployment contract](operations.md).
Separately, `sshd_config` sets `PermitRootLogin yes`, so root may log in over SSH.
Together these mean that holding the `radar` key is effectively root on the server.

Neither was altered here: narrowing sudo could affect the sync timers, the Telegram
unit and `switch-release.py`, and changing SSH authentication on a live host risks
locking access out. Both need the owner's and the other agent's awareness first, and
a per-service check afterwards. Tracked as OPS-4.

## Open receipt evidence

Six receipt photos exist. Four are linked to payments. Two are the same Rimi
purchase photographed twice and stay unlinked while the matching debit is a
Monobank hold; the duplicate guard ensures only one of them can link. Automatic
matching of pending payments is designed in ADR 0005 but not yet merged, so until
it ships an unsettled purchase still waits for the bank.

# Recent entries

# Analytics reads like the workbook — September 17, 2026

Schema version 48, deployed as `46cdb02aef90831341cce4a2ea1c93a97568f6ae`.

The owner liked the household workbook's way of reading a year — total,
average full month, month by month with the figure on each bar and the open
month shaded, what made the big months big, every category in every month —
and asked for the Analytics screen to work that way on the phone and the
desktop, for a year by months, a month by days and a stretch by weeks, without
a legend to decode and without a model writing prose. PR #40 rebuilds it: one
period control with the bucket chosen from the period, Spent / average full
bucket / biggest bucket / not yet placed, horizontal bucket bars with figures
and an average rule (a column chart with shaded weekends past fourteen
buckets), the three heaviest buckets explained by the categories that ran above
their own average and their largest payments, a category-by-bucket grid that
opens into parts and flips on the phone, the fifteen largest payments with
bucket chips, and the rolled-up tree. The aggregation endpoint now carries each
bucket's three largest payments and the period's fifteen, pinned by test. The
"who decided the money" strip moved to System health; the historical-estimates
toggle is gone. Two small notes ride along: the pending-payment paragraph is a
tooltip on the "Bank processing" chip, and a failed explanation save says so in
a toast with the status.

Also in this release, from another session: LHV joins the banks reachable
through the provider (PR #39, migration 48).

Verified after the switch: both services active, 4,140 transactions, no error in
the log, schema 48.

# Either member decides, and the lists take their first polish — September 17, 2026

Schema version 47, deployed as `b947646947271a9fe9ea7aca51264b43640397b7`.

The owner's first look at the split screens found one gap in the rule and a
dozen rough edges. The gap: Katya's payments appeared on the review list but
her payment page said "not available", because every read and action was scoped
to the signed-in member. PR #36 resolves the payment's owner from the payment
itself for the detail read, the bank record, refund candidates, classify, tags,
spending pattern, refund link and unlink, the Telegram question and the saved
explanation, while the audit records the member who signed in — the same rule
Telegram already followed. Migration 47 gives an explanation an `answered_by`
column for that record; migration 46 renames the one Swedbank account to
`Swedbank`. `test/household-review.test.ts` does every action on Katya's payment
as Rodion and checks who is recorded where. PR #37 offers the routine or
exceptional toggle on the other member's payment too.

The refund filter lists purchases that were refunded, not the money-in credits.

The polish (PR #35): the period picker is one button with presets and a
calendar range picker, one month in a bottom sheet on the phone; list rows open
the payment by tapping the row on the phone and lose their History link; a
refunded row shows the net figure only; the amount bounds sit on one line; the
payment pages fold their secondary actions behind one button on the phone; the
header card is two columns on desktop; the mobile menu closes when a screen is
chosen; the "Go to" command menu is gone; the Receipts screen says one sentence.

Verified after the switch: both services active, 4,140 transactions, no error
in either log, schema 47, the Swedbank row renamed.

# Review and Transactions become two screens — September 17, 2026

Schema version 45, deployed as `943f05ae213589ded422212ba2ec2098844e0f62`.

The owner asked for reviewing and browsing to be separate tasks with separate
screens, both fast on the phone, both showing the household, and for a payment
to have a page that leads with the facts as well as the one that leads with the
decision. Four pull requests, each merged on green CI, deliver it:

- PR #30: `GET /api/transactions` selects, filters, counts and cuts a page in
  SQL with a keyset cursor and enriches only the page; it speaks the analytics
  grammar plus review mode, search, kinds, tag, receipts, refunds and an amount
  range compared with what a payment finally cost. Migration 45 adds the
  indexes. A test walks every page of 23 query combinations and requires
  equality, in order, with the in-memory pipeline. The 3,000 UAH priority is
  removed from the API, the screens and historical estimates.
- PR #31: `/review` is the review list — the signed-in member's payments still
  waiting for a decision by default, either's or both on request, a search box,
  no period and no visibility toggles — on a virtualised, infinitely scrolling
  list whose rows carry the account badge with its holder. The sidebar and the
  phone tab bar show the count waiting for the signed-in member.
- PR #32: `/transactions` is the browsing list, household by default, with the
  period picker, search, and the whole filter panel behind one button.
  Analytics drill links land here.
- PR #33: the review page leads with the decision, with what has been said so
  far inside the decision block; `/transactions/:id` is the payment page with
  the facts, evidence and bank record (without the cashback line), Decision
  history and a Review this payment button.

Verified after the switch: both services active, 4,139 transactions, no error
in either service's log, the five indexes present, and 422 outflows waiting for
review on the real ledger (155 Rodion, 267 Katya).

# A settling card hold stops discarding the answer — September 16, 2026

Schema versions 42 to 44.

The owner opened Review and found a Rimi shop and an H&M purchase waiting on
them, and asked why the system could not have been sure about either. It had
been. Both were categorised within ten seconds of import on 13 September — Rimi
as `Food / Groceries` by the model at 0.96 confidence, H&M as `Clothes` by a rule
the owner had confirmed themselves — and both were thrown away two days later
when the Monobank sync ran and the card holds had settled.

The importer compared the whole row, so `status` moving from pending to booked
and `hold` from true to false read as the bank correcting the evidence the
classification rested on. Nothing else had moved: same merchant, same amount,
same date, same merchant category. Across the ledger's whole history all thirty
re-imports were settlements of exactly this kind, so the rule had never once
caught a real provider correction and had only ever destroyed correct answers.

`isSettlementOnly` in `src/domain.ts` now decides this, and the pending-question
rebase uses the same function instead of its own copy so the two cannot drift. A
settlement is recorded as its own `settled` audit event and leaves the
classification standing; anything else that moves, including a key that was not
there before, is still `source_corrected` and still invalidates. Migration 42
restores what was lost. Read against the production database, it will restore
exactly two payments — the Rimi shop and the H&M purchase the owner was looking
at — because the other eighteen had already been re-answered by a later
automatic pass.

Six merchant codes join `MCC_CATEGORY`: photography supplies, florists,
campgrounds, duty free, caterers and paint shops. Seventeen payments move off the
root catch-all, including two of the eight TEMPUSS FOTO payments the owner asked
about; the other six carry a `human` classification from the 12 September
reference import and are left alone. Codes whose business does not imply a single
household purpose were deliberately left out, so 237 payments on the catch-all
become 220 rather than something better — 115 of those remaining are transfers to
people, which rest there by design under ADR 0008.

Twenty-four payments to Wolt, Bolt Food and Glovo move from
`Food / Restaurants / Dining in` to the `Delivery` leaf. The merchant code cannot
tell the two apart because the money really does reach a restaurant; only the
name distinguishes ordering in from sitting down. Both leaves hang off the same
branch, so no total changes.

Separately, two of Katya's Telegram answers were consumed by the poller on
15 September, matched nothing, and vanished leaving only an update number: the
payments stayed unresolved, she was never told, and afterwards nobody could say
which check had rejected them. Schema 43 records the `outcome` and a short
`detail` on `telegram_updates` for every message a household member sends, and
the poller writes a `telegram_reply_discarded` line to its log. Telling the
person in the chat that their answer did not land is **not** implemented: the
outbox carries a question about a payment and has no way to hold a loose note.

Schema 44 removes what was almost certainly the cause. A question is addressed
to the owner of the card, and a reply used to be matched only against questions
addressed to the person who wrote it, so an answer from the other member matched
nothing at all. The owner settled the point — "other members can answer and it
is fine. But better to record who answered" — so either of them may now answer
any question in the shared chat, or confirm any suggestion, and
`telegram_proposal_inputs.answered_by` keeps which of them did. The payment is
still classified as its owner, because that is who may decide it and the
dashboard's authorisation rests on it; the person who explained it is named in
the payment's audit trail, in the reply history and in the chat, where the
confirmation reads `rodion (answered by katya):`. Rows written before this are
read as answered by the owner, which is what the old rule guaranteed.

Two things were found and deliberately not changed. Twelve ATM withdrawals sit as
personal expenses on the catch-all while two identical `Банкомат DN00`
withdrawals are filed `non_personal` — all of them below the roughly 40,000 UAH
threshold at which the owner said a withdrawal is an internal transfer, so the
rule as stated does not settle them. And GymBeam carries two of the owner's own
decisions that disagree with each other, one `Food / Groceries` and one
`Sport / Unspecified`; picking a side is theirs to do.

# A rule can match part of a description — September 15, 2026

Schema 36 and 37. A rule had to equal the whole description, which a bank
reference number makes impossible: every `TRANSFER-<number> Sent money to Rodion
Salnik` is a new string, so one rule answered one payment and the next transfer
needed another. 323 of the owner's 520 active rules match a single payment for
reasons like this.

Rules now offer a second way to match: the description _contains_ this text.
There is no pattern syntax — no asterisks to place, nothing to escape — because
the owner asked for the cleanest possible version and what they actually wanted
was to type the part that stays the same. Matching ignores case, which also
merges the two spellings a bank uses for the same person. An exact rule always
beats a contains rule, and between two contains rules the longer text wins, so a
broad rule can never outvote a specific decision.

The predicate deciding whether a rule describes a payment had been written out
four times inside the triage query. It is now the `rule_matches` SQL function,
written once, with `test/classification-rules.test.ts` holding it and its
TypeScript twin to the same table of cases so the two cannot drift.

Schema 37 files the seven merchants the owner named while reading their July
spending: `hotline.finance` is car insurance, `ТОВ "БМ Фікс"` and `ФОП Величко
Степан Андрійович` are car repairs, `ФОП Петраков Євгеній Сергійович` is padel
court hire, `ТОВ 'Явір-2000'` is building security, `Дія | Штрафи` are speeding
fines, and `Sent money to Rodion Salnik` is the owner moving their own money,
which is not spending at all. None could have been worked out from the data —
the bank sends a money-transfer code and a sole trader's name. Two categories
the owner named arrive with them: `Utilities / Security` and
`Transport / Car / Fines`.

Only the transfers become a standing rule, because that is the only one the
owner asked to answer future payments as well: "i told about one rule only.
others were just to categorise once". The distinction is reach — filing answers
the payments in the ledger and stops, while a rule decides every future payment
without asking, which is the silent generalisation the invariants forbid. That
one rule covers both members: money arriving in Rodion's account has not been
spent by anyone whichever of them sent it, and the ledger does not hold every
account the household has, so the absence of Katya's side today is not evidence
it never happens. A merchant is skipped entirely unless the ledger holds a
payment to
it, so a fresh install or a test fixture comes out of the migration unchanged;
the categories are vocabulary and arrive either way.

# Payments stranded on the catch-all come back — September 15, 2026

Schema 35. The owner asked why a 12,543 UAH shoe purchase showed as Unspecified
yet never appeared in the review queue, and the answer was a gap left by the
move to the shared tree.

The review queue listed a payment only while it was unresolved or provisional.
A payment a person had classified was finished by that test, whatever it was
classified as — including the root catch-all. The tree migration mapped legacy
paths with no successor (`Shopping`, `Apps & services / AI tools`, `Other`) onto
that catch-all, so 291 payments lost what their category had meant and 96 of them
were still sitting there, outside the queue, worth 3,197 USD and spanning a full
year. Nothing had reported that the flattening happened.

Two changes. The queue now also lists anything filed on the root catch-all,
whoever decided it, because a category that names nothing is unfinished work; a
branch catch-all such as `Food / Unspecified` still names its branch and is left
alone. And schema 35 reads the bank's merchant category code back over the
stranded payments, which places 80 of the 96 — 30 in Beauty / Cosmetics, 27 in
Clothes, 16 in Apps & services, 6 in Beauty / Services, 1 in Entertainment /
Hobbies. This repairs a decision the migration discarded rather than overriding
one that stands: a payment whose category still names something is never touched,
and a money-transfer code still places nothing.

The remaining 16 return to the review queue for the owner: six photo-shop
payments, four transfers to named people, three barber payments that carry no
merchant code, two marketplace orders and one advertising charge.

Four merchant codes were added to the table on the way — sports and
miscellaneous apparel, hobby and toy shops, and digital media — chosen by
reading the merchants rather than by spending classifier budget on them.

# A hold is money already spent — September 15, 2026

No schema change; the meaning of an existing status changes, so the effect is
immediate on the numbers rather than on the data.

Ninety-nine Monobank outflows, some a year old, were excluded from every total
as unsettled — roughly 68,578 UAH inside the window being compared against the
owner's own spreadsheet, and the second largest line in that comparison. The
money had gone. The balance in Monobank's payload runs straight through these
rows: 358,113.98 minus 416.41 is 354,054.01, and the next settled operation
continues from there. Asked again four months later the bank still answers
`hold: true` for the same operations, so the flag marks an amount that could be
adjusted rather than money still in the account. The scheduled sync also only
requests the last 31 days, so a hold older than a month is never re-read.

Holds now enter the confirmed totals, the monthly chart and the resting place.
The pending figure is still reported wherever it was, as "of which the amount is
not final". Nothing that waits for settlement was removed: refund links against a
hold are still marked provisional and re-checked, and a receipt stranded on a
hold still moves to a settled row if one appears — both were already correct and
were waiting for an event that, for these rows, never arrives. Enable Banking's
mapping is untouched, because no Wise or Revolut payment has ever arrived
pending.

`pnpm check` passes, with four new tests covering the total, the monthly figure,
the placement and the fact that held _incoming_ money is still not spending.

# Tax and own-card transfers stop counting as spending — September 15, 2026

Schema version 31, recorded as an amendment to
[ADR 0008](adr/0008-attributes-and-the-classification-pipeline.md).

The owner opened Analytics and saw 1,578,894 UAH for July against the 369,092
their own spreadsheet reports. The resting place had placed a sole-trader tax
payment of 880,894 UAH as a personal expense in the catch-all, and a second of
248,606 eight days earlier. Across the ledger it had placed five treasury
payments worth 1,145,672 and thirty-two movements to the household's own cards
worth 502,687.

Both counterparties are named by the bank in its own words, so both are now
recognised before the merchant code is consulted: a description led by `ГУК`, or
naming the treasury service, is `non_personal`; `Переказ на картку` with no
IBAN, comment or card digits of its own is an `internal_transfer` and stays
**provisional**, because one of those thirty-two really was a payment to a
therapist. Transfers to people are untouched and still rest in the catch-all,
which is what ADR 0008 decided. The migration revisits every placement already
made and skips any payment a person has decided.

The ledger already contradicted itself here: eleven of sixteen treasury payments
were `non_personal` before the sweep ran, and only the five nobody had reached
became household spending.

`pnpm check` passes: 467 tests, 463 passing and 4 skipped, 7 of them new.

# Refunds corrected by the owner — September 14, 2026

Merged to `main` with green CI; not deployed. Three corrections to what shipped
earlier the same day, recorded as an amendment in
[ADR 0007](adr/0007-refunds-and-reimbursements.md) and described in
[refunds](refunds.md).

A credit linked to a purchase is no longer classified and no longer listed: it is
already counted through the purchase, so showing it showed the same money twice
and classifying it judged the same money twice. Linking now writes nothing to the
credit, and schema version 26 takes back the `non_personal` classification the
earlier model wrote, for every link whose credit was still exactly as it left it.

What a purchase finally cost is settled in the account's own currency and then
converted like any other transaction, at the daily rate for the purchase's date.
The previous rule converted each side on its own date, which made a charge and its
reversal net to nothing in the merchant's currency and hid the 7.54 UAH of rate
movement everywhere except the account currency.

A refunded purchase still has to be categorised. It stays in the review queue and
in the transaction list, because what the money was for does not change because
some of it came back.

Two consequences follow. A manual link may cross currencies: the incoming amount
is converted at the daily rate for the day it arrived, the view shows paid,
returned and an approximate result, and analytics uses the result. Automatic
matching now covers the historical backlog rather than only new money, while
Telegram questions stay limited to money arriving from now on.

`pnpm check` passes: 399 tests, 41 of them about refunds.

# One shared category tree, built — September 14, 2026

ADR 0006 is implemented in schema version 25 and not yet deployed. The two
per-owner path hierarchies become one household tree; a payment points at a node
instead of carrying a path string, so renaming a category no longer rewrites
history. Parents stop being assignable and every branch carries a visible
`Unspecified` leaf; `Subscriptions` merges into `Apps & services`; tags move out
of the category table into a household list of their own. `Communication` is kept
as a branch and `Restaurants` gains a `Dining in` leaf, both departures from the
ADR's list and both recorded in it.

Three invariants are enforced by the database rather than by review: nothing can
be filed on a heading, the path text is always re-derived from the node, and depth
is capped at three. Where the migration cannot place a payment precisely it uses
the merchant category code the bank recorded, but only for a payment nobody has
classified and only to replace `Unspecified`, so it can never overwrite a decision.
Every payment keeps its previous path in `category_migration_log`.

Account purpose stopped being applied while drawing reports. It is now recorded on
the payment, once, with a reason in the audit trail — so a grocery run on the
business card can be marked personal, which reporting previously made impossible.
Totals are unchanged, a decision a person made is never overruled, an investment
bought from the work card keeps that attribution, and calling the account personal
again undoes exactly what the policy did.

Verified by `pnpm check`: 362 backend tests pass, including five that carry a
version 24 database through the real migration.
`scripts/category-diagnosis.sql` checks the invariants against the live database
and reports how much is still unspecified, month by month. Trips and the ordinary
versus exceptional attribute are not built yet.

# One decision can become a rule; the overview banner reaches Review — deployed — September 14, 2026

The owner asked whether a recurring transfer to an account their wife holds could
be recorded as a rule rather than answered again each month. The machinery already
existed — a confirmed rule may carry `internal_transfer`, and triage applies such a
rule without a Telegram question — but the only way to create one was to retype the
bank description by hand in Categories & rules, where a single character or a
trailing dot makes an exact matcher that never matches. Review's classify form now
offers "Apply this to future payments described exactly as …", taking the match text
from the stored transaction. Re-confirming a different decision for the same
description replaces that rule instead of leaving two that disagree, a payment with
no description saves none, and nothing is generalised without the tick.

The same report exposed why the overview's "1 unresolved · 7 pending" banner led to
an empty Needs review list. Its button linked to `/review` with no parameters, which
opens on All transactions and on the current-month window, and the counts are
household-wide while Review lists only the signed-in owner's payments. The link now
selects the needs-review filter with the window unrestricted, the banner says how
many unresolved payments belong to the other owner, and the empty state explains
that settling payments keep their decision under All transactions.

`pnpm check` passes. Deployed in 5a29a1b and verified: the classify route accepts
the opt-in, `saveRuleFromDescription` is in the running build, and the served
Overview bundle carries the needs-review link.

# Refunds reduce purchases instead of erasing them — September 14, 2026

Merged to `main` in PR 83 with green CI; not deployed. ADR 0007 is now built and
described in [refunds](refunds.md). `pnpm check` passes: 388 tests, of
which 39 cover refunds across matching rules, persistence, totals, automation and
Telegram questions.

A refund link is no longer an all-or-nothing pairing of equal ledger amounts. It
carries a reduction of a known size, so a partial return and an exchange-rate
difference both fit, and matching compares what the merchant charged rather than
what the ledger recorded. The purchase keeps its bank amount and its category and
shows what was paid, what came back and what it finally cost; spending totals, the
household report and historical estimates count the net figure, converting each
side on its own date, so 17.99 EUR out and back nets to nothing in EUR and to 7.54
UAH of rate movement in the account currency.

Merchant reversals are matched automatically once a minute in the background
worker, within one account and roughly four months: an exact original amount, a
partial refund against the only larger outstanding charge, and two charges nobody
could tell apart are linked silently. Candidates that differ, an amount a cent
adrift and money from a person become Telegram questions listing the numbered
purchases; the answer is parsed deterministically, since the reply decides which
purchase shrinks. Only money booked after the existing rollout boundary is asked
about, at most three questions per pass.

Three migrations ship together: version 22 adds the reduction columns, replaces the
membership table with a partial unique index so one purchase can carry several
refunds, and restores the fourteen purchases the previous model had rewritten to
`non_personal`; versions 23 and 24 add the matcher's decisions and the questions.
The version 22 data change was the one that needed care, and it only touches links
whose purchase has not been edited since. Deployment must migrate a restored copy
of production first, as the September 13 rollback required.

# Categorisation and refund designs accepted — September 14, 2026

Two decisions are recorded and not yet built.
[ADR 0006](adr/0006-classifying-what-money-was-for.md) replaces the present
category arrangement, where one hierarchy carries several unrelated jobs and
per-owner trees make family totals unreliable. A payment gets exactly one category
from one shared tree, so category totals sum without double counting; parents stop
being assignable, which is what currently lets `Health` mean both a branch and
"health, unspecified"; and `Subscriptions` merges into `Apps & services`, which are
one idea split across 258 payments. Owner, account, kind, trip, exceptional and
tags become attributes that slice the same money without summing with it. A trip
holds what was spent for the trip rather than everything during it, so it is
assigned deliberately. Investments sit in a third state: out of the headline figure
by default, present on request. The catch-all is kept and instrumented so its use
can be seen falling, since the owner's objection is that it says nothing rather
than that it should not exist.

[ADR 0007](adr/0007-refunds-and-reimbursements.md) makes returned money reduce what
a purchase cost. Matching uses the original amount and currency rather than the
ledger amount, which is why the present feature has produced fourteen links: a
17.99 EUR subscription refunded forty-one days later differs by 7.54 UAH in the
ledger and not at all in EUR. Automatic linking stays within one account, which
keeps one member's refund away from the other's identical subscription on another
card. A refund reduces a purchase without rewriting it, and the interface shows the
original amount, the reduction and the result. Questions are asked only when the
answer would change something: indistinguishable candidates are linked without
asking, differing ones are asked about, and money from a person is always asked
about.

Both designs come from the owner's stated requirements; product research informed
the trade-offs and did not decide them. No code was written at that point; ADR 0007
was built the same day, in the entry above.

# PDF receipts — implemented and tested, not deployed — September 13, 2026

The bot accepts a PDF in the family chat alongside photos. A PDF is rendered to
page images with poppler's `pdftoppm`, which was already installed on the server
and needs no new package, invoked through `execFile` with an argument array in a
temporary directory removed in a `finally`, bounded by a thirty-second timeout, a
four-megabyte rendered total and an eight-page cap decided by `pdfinfo` before any
rendering happens. Rasterisation sits behind an injected `PdfRasterizer`
interface, so replacing poppler is one function and no test needs it installed.

Pages are sent as separate images in one request rather than stitched together, so
a multi-page document still costs a single budget reservation. An unreadable or
over-long PDF is marked failed before anything is reserved and the owner gets a
fixed reply asking for a photo, so a bad document can never spend money. The
original PDF is stored as the evidence with a rendered first page as the
thumbnail; the app shows the thumbnail and links to the PDF through a new
`/api/receipt-file` route served with `nosniff` and a sandbox policy. Duplicate
detection by digest runs on the original bytes, so a resent PDF costs nothing.

Schema version 21 adds the preview columns; the migration test fails without the
version block and passes with it. Server requirements including poppler are
recorded in [what the production server needs](server-requirements.md).

Verified: `pnpm check` passed, 357 tests (354 pass, 3 pre-existing skips). Real
poppler rendering was not exercised locally because poppler is not installed on
the development machine; the implementation was driven end to end against stubs
reproducing poppler's output shape, and the real binary must be verified on the
server before this is called working. Not deployed.

# Brand abbreviations match their registered name — September 13, 2026

The first receipt to arrive after the pending-matching release stayed unlinked.
Its payment was present and agreed exactly on amount, currency and day: an `H&M`
debit of 62.96 EUR against a receipt naming `H&M Hennes & Mauritz`. Merchant
comparison was the blocker. Tokenization keeps only fragments of three characters
or more, so the abbreviation's letters were discarded and the receipt's identifying
tokens, `hennes` and `mauritz`, appear nowhere in the bank's `H&M`.

One normalized name being a prefix of the other now also counts as a match, in
either direction; the earlier rule additionally failed when the abbreviation was
the receipt's own merchant. A prefix rather than a substring, so `Rimi` and
`RIMAC` or `Apotheka` and `APOTEKA` stay apart, and the exact date, exact total
and single-candidate rules still decide before a merchant is considered at all.

Verified: `pnpm check` passed, 348 tests (345 pass, 3 pre-existing skips),
including an end-to-end link of an abbreviated description to a pending payment.
Not deployed.

# Receipts match pending payments — implemented and tested, not deployed — September 13, 2026

Automatic matching no longer waits for a payment to be booked. The owner's
reasoning decided it: a receipt records that a purchase happened, and the purchase
is the same fact whether the bank has settled it yet or not. The rule is uniform
across banks, recorded in [ADR 0005](adr/0005-matching-pending-payments.md).

Production evidence supported the change. All fourteen recorded pending-to-booked
settlements kept the same transaction row and the identical amount, and Enable
Banking has never produced a pending row at all, so the booked-only rule was
delaying Monobank purchases and doing nothing for Wise or Revolut.

A settlement difference never detaches a receipt. When a linked payment settles at
a different amount or currency, the link stands and the difference is recorded and
shown on the receipt card with both amounts. Undoing a correct link because a
number moved would discard true evidence, and amounts legitimately move through
tips, fuel pre-authorizations and currency re-rating. A difference on a link the
owner made by hand is shown but never announced, because they chose that payment
deliberately; an automatic link is announced once, keyed on the settled amount so
the same difference is never repeated.

If a bank reports a settlement as a separate row rather than revising the hold, the
receipt follows the evidence to the settled row instead of being stranded. That
move requires exactly one settled candidate carrying no receipt of its own, never
overrides an attachment a person made, and is recorded as an attachment event with
its previous payment.

Schema version 20 adds `settlement_difference`; the migration test bites, failing
without the version block. Verified: `pnpm check` passed, 346 tests (343 pass, 3
pre-existing skips). Not deployed.

# Test suite and CI made roughly twice as fast — September 13, 2026

Measurement contradicted the assumption behind the work. Running `migrate` costs
about 72 ms; booting a PGlite engine, which runs initdb, costs about 650 ms, nine
times more. The eighteen migration version blocks were never the problem.

Under `node --test`, `migrate` now restores a throwaway in-memory database from a
snapshot of the first database migrated in that process, about 140 ms instead of
720 ms. The snapshot is a by-product of one real migration per process, so the
migration code still executes everywhere. Four guards keep it out of production:
only an unnamed `memoryDatabase()` qualifies, only a database that has not been
queried, only when `NODE_TEST_CONTEXT` is set, and a failed snapshot falls back to
a real migration. Every production entry point uses `postgresDatabase` and the demo
uses an on-disk path, so neither is eligible. `test/database-snapshot.test.ts` pins
isolation and was mutation-tested: injecting a row into the snapshot builder makes
it fail as intended.

`--test-concurrency` stays at 2. Measured across 1, 2, 3, 4, 6 and 8, anything above
3 is slower on this machine because parallel files saturate memory bandwidth, not
CPU. CI now caches the pnpm store keyed on the lockfile. `pnpm test:progress` adds a
streaming reporter so a watched run shows test names instead of silence.

Verified: `pnpm check` fell from 188-213 s to 93-127 s, confirmed independently at
93 s by the supervisor after rebasing onto schema version 19. 331 tests, 328 pass,
3 pre-existing skips, no failures in any run. No test was deleted, skipped or
weakened. Documentation and test infrastructure only; no application behaviour
changed. Not deployed.

# Receipt schema upgrade reached production only after a failed release — September 13, 2026

A release of the three merged receipt changes was switched and immediately rolled
back. The web service started and passed readiness, but the Telegram worker exited
with its generic configuration_or_poll_error. Inspection showed why: none of the
new columns existed and `receipt_jobs_state_check` was unchanged, so the new code
queried `feedback_state` against a column PostgreSQL did not have.

Root cause: the three pull requests added their statements to
`initializeReceipts`, which runs only inside the one-time schema version 15 block.
Production is at version 18, so the statements never executed there, while every
test passed because tests build a schema from scratch. Comments in the code
asserting that `initializeReceipts` runs at every startup were wrong and are
corrected.

The additive statements now live in an exported `upgradeReceiptEvidence`, called
both from `initializeReceipts` for new databases and from a new schema version 19
block for existing ones. Three tests rebuild an already-migrated database without
the upgrade and assert that migrate applies it, backfills feedback state for
resolved receipts only, and changes nothing when re-run; all three fail without
the version 19 block and pass with it.

Rollback was clean: `switch-release.py` restored the previous release, the worker
came back active and has run without restarts since. No schema change had been
applied, so no data migration had to be undone. The ledger held 3,908 transactions
and six receipt jobs (four matched, two pending) throughout. Verified: `pnpm check`
passed, 328 tests (325 pass, 3 pre-existing skips). Not redeployed; the next
attempt must also restore a predeploy dump into a disposable database and run the
migration against it before switching.

# Status restructure and deterministic tooling — September 13, 2026

docs/STATUS.md is read at the start of every session and had grown to 1,214 lines
(about 19,000 tokens), with its authoritative-looking "Current status" section
buried at line 695 and naming a release that was no longer live. It is now a
rewritten-in-place current-state section, the ten most recent entries, and
[an archive](status-archive/2026-09.md) holding the rest. `scripts/archive_status.py`
performs the split deterministically and re-points relative links; content is moved
verbatim so no recorded result can be silently reworded.

Four deterministic checks replace work that was being re-derived by hand:
`scripts/deploy-status.sh` compares the deployed release with `origin/main`
including schema statements, `scripts/receipt-diagnosis.sql` answers "why is this
receipt unlinked" read-only, `scripts/check_repository.py` now rejects unresolved
merge-conflict markers, and a test asserts the receipt migration is idempotent
across repeated startups without re-running the feedback backfill.

The agent working model is written down in
[how agents work on this project](agent-development-model.md). The unrestricted
deployment sudo found during inspection is recorded as a known deviation and
tracked as OPS-4; it was not changed. Verified: `pnpm check` passed, 326 tests
(323 pass, 3 pre-existing skips). Documentation and tooling only; no application
code changed.

# Receipt matching, duplicates and double-link guard — implemented and tested, not deployed — September 13, 2026

Read-only production inspection explained two owner-reported problems. A receipt
extracted as the registered name could never match a card description, because
matching required the normalized merchant to be a substring of the description.
Merchant comparison is now token-based, dropping legal forms and geography, so a
registered name matches its card description while a different brand still does
not. Enable Banking reports a booking day one to three days after purchase, so its
candidates now accept a three-day window; Monobank reports the real instant and
keeps the exact day. Uniqueness is still required across the whole window.

The reported duplicate had no detection at all: intake deduplicated only by
Telegram message. Identical image bytes are now caught before any paid model call,
and a second photo of the same purchase is marked after extraction. Separately, a
payment that already carries a matched receipt never gains a second automatic
link — the earlier behaviour, which an existing test had asserted as correct, is
how one purchase acquired two attached receipts. Receipts already pending before
this release are covered by that guard, since intake checks cannot see them.

Verified locally on branch `feat/receipt-matching-window`: `pnpm check` passed.
Not deployed. No production data was modified; inspection was read-only.

# Telegram feedback on receipt photos — implemented and tested, not deployed — September 13, 2026

The Telegram worker now answers on the owner's own photo message: a 👍 reaction
once the receipt is linked to a payment (automatic match or manual link in the
app), 👀 while the receipt was read but no unique booked payment exists yet, and a
fixed plain reply for a non-receipt or a failed read. `TelegramTransport` gains
`react()` and `reply()` behind one bounded fixed-origin request helper; `send()`
is unchanged. `receipt_jobs` gains `feedback_state`, `feedback_attempts` and
`feedback_after`; existing rows are backfilled as acknowledged when the columns
are first created, so the upgrade sends no retroactive reactions. `notifyOne`
runs once per worker loop, commits the attempt and doubling backoff before the
network call, abandons a job after five failures, and never puts extraction
data in a message. Verified locally on branch `feat/receipt-telegram-feedback`
after rebasing on the merged receipt deletion (PR #70): `pnpm check` passed (see
PR for counts). Not deployed; no live Telegram call has been made, so the bot's
reaction permission in the family group is unverified until first use.

# Receipt deletion — implemented and tested, not deployed — September 13, 2026

Owners can delete a receipt photo from the Receipts page after an inline
confirmation. Deletion is a soft delete: the `receipt_jobs` row remains as a
`deleted` tombstone because `llm_cost_ledger.receipt_id` references it and the
shared AI budget accounting must stay intact; the stored image and extracted
content are removed. A linked payment is detached, its receipt-derived automatic
category is invalidated and a `receipt_detached` audit event is recorded on the
payment; attachment history is kept. Deletion is refused (HTTP 409) while the
photo is being read. The migration widens `receipt_jobs_state_check` idempotently.
Verified locally on branch `feat/receipt-deletion`: `pnpm check` passed, 312 tests
(309 pass, 3 pre-existing skips gated on TEST_DATABASE_URL). Not deployed; no
production data or server state was touched. Motivated by an owner-reported
duplicate receipt; duplicate detection by image hash remains open.

# One-time polling follow-up completed — September 12, 2026

The scheduled 19:45 Europe/Riga follow-up ran on the next wake after 22:01 Riga.
Read-only inspection: all three Enable Banking half-hour markers and 30-minute
post-completion timer drop-ins are active; no blocked/conservative latches exist.
Since 13:00 UTC, Rodion Wise and Revolut each logged 11 successful scheduler runs;
Katya Wise logged nine successes and one cooldown deferral. Latest successful
imports: Rodion Wise 18:56:47 UTC, Revolut 18:56:48 UTC, Katya Wise 18:43:22 UTC.
Persisted retry-after timestamps equal those successes plus 30 minutes. Import
windows reach the current day. Zero changed rows on Rodion connections are not
errors. The obsolete generic enablebanking:rodion row is not a current timer.

Telegram worker is running successfully. Today's outbox has 15 sent questions and
no other states; no duplicate transaction/revision groups exist. Current eligible,
triaged live-window payments without any prior question: zero. Today's triage rows:
193 ready and eight uncertain (historical/current mix; uncertainty is not a worker
failure). These aggregate checks establish queue health, not a new synthetic
end-to-end delivery test or proof of complete bank history.

No extra bank/AI requests, messages, server changes or latch resets were performed.
Sticky six-hour fallback after the existing 24-hour error cooldown remains intact;
no rate-limit errors were observed to trigger it. The $10 cap is unchanged.
One-time follow-up is complete; do not repeat on later heartbeat wakes. The missed
S3 setup reminder is delivered with this result: encrypted backup in existing AWS
S3, owner-controlled recovery password and off-server restore test remain deferred;
no paid resources were created. Kate's activation reminder remains cancelled.

# Backend assessment and initial baseline — September 12, 2026

Read-only code audit and live API samples saved in [backend assessment](backend-assessment.md).
Full-year EUR Overview returns 5.926 MB in 492–572 ms locally; default review
0.993 MB in 222–235 ms; receipts 1.8 KB in 3.7–6.7 ms. These are three-sample
server-local observations, not end-to-end browser timings or p95. Individual
SQL/CPU stage attribution remains unmeasured (isolated probe auth failed).
Recommendation, not selected migration: retain TypeScript/Node/PostgreSQL, improve
read shapes and repeated work, and adopt Fastify incrementally for HTTP structure.
No app code, dependency, financial data or deployment changed.

# Consolidated backlog audit — September 12, 2026

Documentation-only audit of the owner conversation and project plans created
[TODO](TODO.md) as the canonical open-work checklist. Backend refactoring is now
explicitly separate from completed query batching and remaining frontend cache
migration. Restored follow-ups include new-account policies, FX coverage UX,
settings/navigation audit, rule evaluation, history reconciliation and operational
failure checks. Closed features are distinguished from deferred item analytics and
S3 setup. No code, financial data, scheduled jobs or deployment changed.

# Kate Wise coverage clarification — September 12, 2026

Owner confirmed that low Wise transaction volume is expected. A read-only spot-check
matched the six clearly visible screenshot entries by date and amount against the
12 imported EUR rows. One payment uses a transfer reference in the API description
rather than the merchant label visible in Wise. No financial records were changed.
Remove the suspected low-count coverage issue from active deferred work; reopen only
if a specific missing entry is identified. This does not claim full statement
reconciliation or independently prove USD coverage. No application deployment needed.

# Explanation-first review and cash — verified September 12, 2026

Release **7386d2bde260f6c6abfc6b4c6a1e07f525e9f0e8** is live. PR64 merged as
3b803dc8. Exact-head full CI **34709799822 passed**. Migration 18 adds the durable
transaction_explanations table. Full backup/restore comparison matched all **36
tables**. Both logins, 18 APIs, cash page, saved explanation sources, owner isolation,
receipt access and adjacent-build assets passed live verification. The reported
confirmed Telegram explanation remains visible in list and payment detail APIs.

Payment review is a full page with current classification, prominent explanations
and receipt evidence. Text saves before optional AI; suggested type/category/reason
remain editable and require explicit atomic confirmation. Current saved drafts
survive Back/Forward/reopening, and detail entry refreshes stale context without
polling. Confirming or changing ancillary fields keeps the payment page open.
Manual fields are protected while a suggestion request is pending.

Cash entry accepts amount and description, with editable date/currency and signed-in
owner. Exact, idempotent manual_cash ledger records use the normal reporting/FX
pipeline after confirmation. Their description is also saved as app explanation.
The initial state is unresolved; unavailable AI does not invent a spending category.
Cash and current app drafts are protected from background questions/classification.
Existing bank withdrawal classifications were not changed; reconciliation remains
separate to avoid double counting. Cash lock ordering follows receipt processing.

49 focused backend checks passed before final integration; integrated API/view
checks and builds passed, followed by 11 focused server tests. Synthetic browser
checks covered explanation → prefilled fields → history navigation → confirmation,
and cash creation → saved context → confirmation. Mobile cash layout at 390px had
no horizontal overflow. Tests used synthetic data and mocked AI; no test cash
purchases or paid model calls were created in production.

Ledger remains 3,894 rows at verification; four shared receipts are available.
App, Telegram, all five bank timers and FX timer are active. Shared $10 budget is
healthy (2,672 measured requests, five legacy, zero uncertain). Source transfer
approval briefly needed destination evidence; read-only identity checks matched
the documented Tailscale host and the same transfer then passed automatic review.
Remaining scope and deferred work are current in roadmap.

# Saved Telegram reply history — verified September 12, 2026

Release **c9eb7c854aa7c8446cf27b67a32a7de2a5b094c2** is live; PR62 merged
as f594f643. Exact-head full CI **34707679355 passed**. Four focused history/API
and presentation tests passed locally and on the server; seven existing Telegram
regressions passed. Browser checks confirmed saved text, status, payment linking
and in-place refresh; the 390px layout had no horizontal overflow.

The reported explanation was already saved and confirmed. The review API exposed
only pending replies and the payment modal omitted input history. It now returns
all owner-scoped reply statuses, and both Replies and payment details show the
original wording, timestamp and outcome. Live checks verified that exact confirmed
reply in both API views and rejected cross-owner detail access. No input repair,
classification rewrite, schema migration, synthetic Telegram messages or paid test
calls were needed. A previously open client needs to load the updated application;
subsequent incoming replies use the explicit Refresh controls without page reload.

Full backup/restore comparison matched all 35 tables. Both logins, 18 APIs, settings,
FX agreement, four shared receipts and both adjacent asset sets passed verification.
Ledger count was 3,894 after normal imports. App, Telegram, all bank timers and FX
timer are active. Shared $10 budget healthy (2,672 measured, five legacy, zero
uncertain requests); its normal worker remains active. Deferred work is unchanged.

# Navigation and settings release — verified September 12, 2026

Release **b417aeea7d7f0db77075e8aeb8ddefcce88c87ce** is live. PR60 merged as
9a437f47. Exact-head full CI **34706880862 passed**; initial integration CI
34706465056 also passed. Migration 17 adds settings and audit tables. Full local
backup/restore comparison matched all **35 tables**. Both owner logins, 18 APIs,
settings access, review currency/scope and receipt availability passed live checks.
The ledger has 3,892 rows at verification after normal imports; no classification
rewrite was part of this release. The shared $10 budget remains healthy, with
2,670 measured requests, five legacy requests and zero uncertain requests.

TanStack Router 1.170.35 + Query 5.102.8 now provide URL-backed navigation and
private in-memory caching for Transactions/Receipts. Filters, currency and selected
details participate in browser history. Rodion-only Settings manages shared default
hiding of non-personal payments, confirmed transfers, linked refund credits and
payments that came to nothing;
per-view overrides and direct links remain available. Investment exceptions remain.
Existing React/Vite, shadcn/Tailwind/Recharts/Lucide and classification semantics
are retained. Remaining legacy screen cache migration is documented separately.

Mobile 390px checks confirmed an 8px Period label/control gap, no horizontal overflow,
in-place currency changes, details/Back behavior and Settings saves. Desktop dark
layout and Receipts navigation were checked with synthetic data. Four focused
backend tests and five navigation/deployment tests passed locally/on server; the
asset-retention wrapper includes five Python safety cases. Ten-payment category/tag
fixture query count fell from 28 to 3 with identical results; production latency is
not inferred from that fixture. The live 18-API check's slowest response was 0.35s.

Authenticated fingerprinted assets cache privately. Both the previous release's
31 native assets and this release's 39 remain accessible after the switch, including
rollback preparation. Retention is bounded to the adjacent build; older tabs may
still need a refresh. HTML, APIs and receipt images remain no-store.

FX date fix 63be733 remains included. The 2026 check has zero missing conversions
for UAH/EUR/USD/GBP. The updated FX timer checks 05/11/17 UTC with jitter; app,
Telegram, all five bank timers and the FX timer are active. Existing report
snapshots stay unchanged. S3 protection remains deferred; this was a local restore.

Next separate work: scoped resolver conditions/conflict previews/shadow evaluation,
remaining screen cache migration, receipt items/PDFs, one-time messenger exports
and S3 recovery. See roadmap for other unfinished coverage and product work.
