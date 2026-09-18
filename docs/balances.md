# Balances

What every account of the household holds, on one page (`/balances`).

## A balance is evidence, not arithmetic

Nothing here derives a position by adding payments up. There is no opening
figure to add them to, and the importer replays a rolling 31-day window, so a
sum of what this application has seen is not what an account holds. Every figure
on this page came from a bank saying so, and is stored with the moment it was
observed. The card shows that age, because the banks are polled on timers
between half an hour and six hours apart and a figure without its age is a claim
the page cannot support.

## Where the figures come from

| Provider                                      | How                                                                                           | Cost                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monobank                                      | `balance` and `creditLimit` in the `client-info` response the account listing already fetches | none; no extra request, nothing against the 60-second-per-token limit                                                                                                   |
| Enable Banking (Wise, Revolut, Swedbank, LHV) | `GET /accounts/{uid}/balances`, one request per account per run                               | one request, but **not** another background fetch against the four-a-day allowance many banks impose, which counts unattended polls rather than the requests inside one |

Both are recorded in `syncBank` (`src/bank-sync.ts`) before the payments are
imported, and both are **best-effort**: a rate limit, a resource the bank does
not serve or a payload this code does not recognise leaves the previous figure
in place to go visibly stale, and the import carries on. A balance is a nicety
and the payments are the point. Nothing in the balance path may turn a
successful import into a failed one.

There is no way to ask a bank for a balance from the web application. Balances
refresh when the existing timers run, and the Refresh button on the page
re-reads what is stored, never the bank. Adding an on-demand bank call would be
a new capability with its own rate-limit surface and is deliberately not here.

Enable Banking publishes several balance types per account. The page wants what
is spendable now, so `ITAV` is preferred, then `CLBD`, then the interim and
opening figures. A forward-dated or informational figure is skipped entirely
rather than shown as the account's position. An account holding several
currencies returns one entry per currency, which is the only shape that
describes it.

## Storage

`account_balances`, one row per account per currency, holding the amount in
exact integer minor units, the agreed overdraft when the provider publishes one,
the provider's own `as_of` when it states one, and `observed_at`, which is
always known and is what the age on screen is measured from. A currency a bank
stops mentioning keeps its last row: a gap in one answer is not evidence that
money left an account. No history is kept; this table is the current picture.

## Conversion

The household total uses the display currency and the same daily rates the
spending figures use, through `convertedBalances` in `src/account-balances.ts`.
A balance converts at the newest daily rate on or before the day it was
observed, walking back up to a fortnight, because the rate feed is a timer of
its own and insisting on the same day's rate would blank the total every morning
until it had run. Each card names the date of the rate it used. A balance with
no rate in that window is reported as missing rather than dropped, so the page
says a total is incomplete instead of quietly reporting a smaller one.

**What is converted is own money, not the stated balance.** Each row converts
the stated figure less the agreed overdraft the bank publishes with it
(`amountMinor − creditLimitMinor`), so `reporting.totalMinor` and every
`reporting.rows[].convertedMinor` are the household's, with none of the bank's
money in them. The subtraction happens before the conversion, in exact minor
units, because a difference of two rounded conversions is not the same figure.
An account overdrawn past its own money converts a negative, which is the
truthful answer and is shown as such. The stated amount and the limit travel
with each account unchanged, so a card can still show what the bank said.

## Whose money is shown

Both members' accounts, to either sign-in, as the overview already reports the
household. The tabs are a view, not a permission: what each person may _decide_
stays owner-scoped on Review and Accounts, and nothing on this page decides
anything. The selected tab lives in the URL (`?who=`), so Back and Forward work.

## Arranging the cards

Arrange turns on dragging; the whole card is the grip, which is the size the
gesture wants on a phone, and the primitive also supports picking a card up with
the keyboard and announcing each move. The drag code is a chunk of its own,
loaded only once somebody turns arranging on, so a screen that is read far more
often than it is rearranged does not pay for it.

The order is stored per person in `ui_layouts` (`src/ui-layout.ts`) and saved
through `POST /api/ui-layout`. This is not the household settings store: that
one is administrator-only and holds decisions that change what the figures mean,
whereas where somebody likes their cards to sit changes nothing. Both members
write here for themselves and neither can move the other's arrangement.

The stored value is a list of keys, not a complete description of the screen.
Anything the list does not mention keeps its natural position behind the ones it
does, so an account opened tomorrow appears without the layout being rewritten
and a closed account leaves a key that simply never matches again. One stored
list covers both tabs, and a drag in one tab slots the moved keys back into the
positions that person's cards already held, so rearranging your own accounts
cannot discard how the other member's were arranged.

Saving carries the revision it was read at and a stale one is refused with 409,
the same optimistic check the settings screen uses. The card moves as soon as it
is dropped; if the save fails the whole list goes back to where it was, so
nobody is left looking at an arrangement that was never recorded.

## Own money, and the groups

Where a bank publishes an agreed overdraft it counts that limit inside the
balance, so the figure the bank states is not what the household owns. The
page's main figure per account is the stated balance less the limit — the
household's own money — with the stated figure and the limit in a small line
beneath; a negative result is shown as such. The household total is own money
too, and it is the API that makes it so: `reporting` subtracts each limit from
its own balance in that balance's own currency, before any conversion, so there
is no case left where a limit in another currency cannot be taken out. Nothing
is estimated, and nothing of the bank's is counted.

Accounts are listed in three sections: Personal, Non-personal (business and
investment accounts) and, only when any exist, Purpose to review. Each card
is titled with the account's full name — member, bank, product and currency
(`displayName` from the API; see [assets](assets.md)).
