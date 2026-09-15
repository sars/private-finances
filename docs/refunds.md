# Refunds and money that comes back

Merged to `main` on September 14, 2026 and deployed. This is the workflow
document for [ADR 0007](adr/0007-refunds-and-reimbursements.md), including the
owner's amendment recorded there. Read the ADR for why; read this for what runs.

## What a refund does to a purchase

A refund reduces what a purchase cost. It does not erase the purchase, change the
amount the bank recorded, or rewrite the category. The purchase carries its
reductions beside it, and the interface shows all three figures: what was paid,
what came back, and what it finally cost.

**What it cost is settled in the account's own currency.** The purchase's amount
plus everything that came back gives one figure in that currency, and from there
it is converted exactly like any other transaction, at the daily rate for the
purchase's date. A subscription charged at 936.39 UAH and refunded at 928.85 UAH
cost 7.54 UAH, and that 7.54 is what any other display currency converts. A
refund larger than its purchase reduces that purchase to nothing; it never
becomes negative spending or income.

Spending totals, the household report, monthly breakdowns and historical
estimates all count that figure.

**A linked credit is not classified and is not listed.** It is already counted,
through the purchase it reduced, so showing it would show the same money twice
and categorising it would judge the same money twice. Nothing is written to the
credit when it is linked, and nothing has to be restored when the link is
removed: it simply becomes unexplained incoming money again.

**The purchase still needs its category.** What the money was for does not change
because some or all of it came back, so a refunded payment stays in the review
queue, stays in the transaction list, and shows what it finally cost beside what
the bank recorded.

## How a match is decided

Matching compares **the original amount**, what the merchant charged, not the
ledger amount, because the exchange rate moves between a charge and its reversal.
Monobank records the original amount and currency directly; Enable Banking
supplies an instructed amount when a conversion happened. When neither is
present, the ledger amount is the original amount.

Automatic matching stays **within one account and one currency**: a reversal lands
on the card that was charged, which is what keeps one household member's refund
away from the other's identical subscription. The candidate must be an
outstanding purchase on the same account and currency, with an overlapping
merchant name, booked no more than 120 days before the refund (or up to 3 days
after it, for bank booking-date inversion).

Matching is not limited to new money. Every unexplained credit is considered,
including the historical backlog, and every confident link is made without
asking. A payment a person has already classified or linked is never touched.

The system links silently when the answer cannot be in doubt:

| Situation | What happens |
| --- | --- |
| One candidate with the same original amount | Linked, no question |
| Several, and exactly one also repeats the ledger amount exactly | Linked to that one, no question |
| Exactly one candidate a whisker away — three minor units or one per cent | Linked to that one, no question |
| A partial refund with several possible parents | Linked to the latest of them, no question |
| Several candidates a whisker away | The closest in amount, and if that ties, the one nearest before the refund |
| A partial refund with exactly one larger outstanding charge | Linked, no question |
| A candidate already reduced by as much as it was charged | Not a candidate at all |
| Several candidates nobody could tell apart | Linked to the nearest preceding one, no question |
| Several candidates that differ | Question |
| An amount that matches nothing exactly, including a cent adrift | Question |
| Money from a person | Question |
| Nothing plausible | Stays visible as unexplained incoming money |

Among charges nobody could tell apart, the refund goes to the **nearest one
before it**, not the oldest. The owner's ride receipts settled this: a ride
hailed at 14:15 and cancelled at 14:16 returns the hold placed a minute earlier,
while the ride hailed at 14:03 was still running and kept its own hold until it
ended. The original decision said oldest, reasoning that the choice could not
matter; it does not change a total, but it decides which of two rows tells the
truth.

Refunds are also assigned **as a set**, not one at a time in arrival order. A
credit that names its parent exactly claims it before any credit that would only
be guessing, so a partial refund cannot take the charge an exact one needed and
leave it with nothing. Without that, the order the bank happens to deliver two
refunds in decides which purchase ends up wrong.

**A purchase that has already given its money back is not a candidate again.**
Once a purchase has been reduced, only what is left of it can come back, and how
much is left is judged in the currency the merchant charged in. This matters
because the ledger lies about it: a 14.74 EUR booking returned in full still
showed 8.93 UAH outstanding, because the hryvnia moved 1.2% in the month between
the charge and the cancellation. Those few hryvnia kept a spent booking in the
running against every later 14.74 EUR cancellation, and since its reductions
differed from its neighbours' the candidates stopped looking indistinguishable —
so three of the owner's Playtomic cancellations became questions instead of
links. Scaled back into euro the residue is 0.17 of 14.74, which is plainly
nothing. A purchase nobody has touched stays a candidate whatever its size,
including for a reversal larger than itself: that is a question worth asking, and
the charge is the only useful thing to offer as its answer.

Two charges count as indistinguishable when the merchant charged the same
amount in its own currency, the name is written the same way, and neither has
been reduced already. **How a charge was categorised plays no part in matching.**
The owner's instruction is plain: "in general i don't care about category in
terms of looking for refund match." A category is a label chosen afterwards, not
evidence about which purchase a merchant gave money back on, and treating a
category difference as ambiguity left refunds unlinked because the same rides had
been filed two ways.

A merchant is its exact name where the bank writes one. "Bolt" and "Bolt Food"
share a word and are different services, so a refund naming one of them exactly
never attaches to the other; the looser token comparison only applies when no
charge carries the name exactly.

The ledger amount and the category used to be part of that test, and both were
wrong: the same ride is a different number of hryvnia on a different day, and a
category is a label chosen afterwards.

The ledger amount is not the matching key, but it is the tie-breaker. Two rides
charged at the same 2.00 EUR on different days are different numbers of hryvnia,
and a cancellation repeats the hryvnia of the one it belongs to; when exactly one
outstanding candidate is that amount to the kopiyka, that is the parent and
asking would be asking about something already known.

**Money the bank has not settled is matched anyway, provisionally.** A hold is
linked like any other refund and the link is marked provisional. Every pass
re-reads the two amounts: when the bank settles them the reduction is
recalculated from what it finally recorded and the mark is cleared, and when a
hold is released without settling the link is removed with an audit entry. This
is the one case where a link is undone without a person, because it was
provisional by construction; a correction to two settled amounts is still only
surfaced.

The whisker rule that links a near-miss is a uniqueness test rather than a
tolerance band: the gap must be at most three minor units or one per cent of the
larger amount, and it decides nothing unless exactly one candidate is inside it.
Two candidates equally close remain a question, and no weaker rule may reach past
them. The same whisker allows a reduction to exceed its purchase by that much,
which is what happens when the rate moves between a charge and a reversal that is
a cent smaller.

**A stored decision records which edition of the rules made it.** When a rule
learns something — `REFUND_RULES_VERSION` in `src/refund-automation.ts` — every
earlier decision is looked at once more. Raise it for anything that changes what
a decision would be, including a change to what the rules are allowed to see: the
edition that let holds reach the matcher changed no rule at all, and every
decision taken while they were invisible was still wrong, so an improvement reaches the questions
already recorded instead of leaving them standing. A decision that already
produced a link keeps its old edition for good: the credit is linked, and a link
is never undone automatically, so there is nothing left to reconsider.

## Questions

Questions go to the family Telegram chat and list the candidate purchases,
numbered. The answer is parsed deterministically: a number, or "none". No model
reads it, because the reply decides which purchase shrinks. An unclear reply gets
one line of guidance and the question stays open. "None" leaves the credit
visible as unexplained incoming money and stops the matcher asking again.

Only money booked after the rollout boundary `TELEGRAM_LIVE_QUESTIONS_FROM` is
asked about, at most three questions per pass, and business and investment
accounts are excluded. The backlog of unexplained incoming payments is left to
the application rather than interrogated in Telegram.

Anything that changed underneath a question — a corrected amount, a classification,
a link made elsewhere — drops the question instead of linking something else.

## The matcher may redo its own work, once, when the rules change

Every automatic link records the edition of the rules that chose its parent. When
that edition moves on, those links are released — with an audit entry each — and
the following pass assigns the whole set again. Only the matcher's own work is
touched: a link a person confirmed, or a credit or purchase a person classified,
is left exactly as it stands. The owner approved this narrowly, after their ride
receipts showed two links that were the wrong way round and that no rule change
could otherwise reach.

## Links are never undone automatically in any other circumstance

A later correction can make a link look imperfect. The link is kept and the
disagreement is shown: the purchase displays a warning that an amount changed
after the refund was linked, and both sides reappear in browsing even when
refunded payments are hidden. Only a person removes a link, and removing it
restores the credit's earlier classification when nothing has changed since.

## Attaching and undoing by hand

In the app, an incoming credit offers the purchases it could be returning, with
each candidate's remaining unreduced amount and the original amounts compared. A
purchase shows its reductions and an undo control for each. A person may confirm
a refund that arrived on another account or in another currency; automatic
matching never does.

**A refund in another currency** is converted into the purchase's currency at the
daily rate for the day it arrived, and that converted figure is what reduces the
purchase. The view keeps both: the amount paid, the amount returned as it
arrived, and the approximate result, which is the figure that matters and the one
analytics uses. When no rate covers that day nothing is guessed — the link is
refused at the time, and an existing link whose rate later goes missing leaves
the purchase at its full price with the disagreement shown.

A reduction may not exceed what the purchase cost, unless the merchant returned
exactly what it charged in its own currency and the ledger difference is
exchange-rate movement. That exception is recorded on the link as `fxSurplus`.

## Where it runs

Automatic matching runs in the background worker
(`private-finances-telegram.service`) once a minute, draining the queue in
batches rather than a fixed handful per minute: after a rule changes there are
hundreds of decisions to re-read, and the work is arithmetic over a few thousand
rows. The number of batches per pass is bounded so it can never run away with the
loop. It needs no AI key, no
credentials and no network access: it compares amounts already in the database.
Questions are queued in the same pass and sent through the existing Telegram
transport, so they share its rate limiting, leases and recovery.

Unmatched recent money is retried for thirty days, because a charge is sometimes
imported after the refund that returns it. Older unmatched money is reconsidered
only when the bank revises it.

## Schema

- Version 22 turned a refund link into a reduction of a known size:
  `refund_links.reduction_minor`, `currency`, `origin`, `evidence`, a partial
  unique index keeping one credit inside one link, and the removal of the
  `refund_link_transactions` membership table so one purchase can carry several
  refunds. It also restored purchases that the previous model had rewritten to
  `non_personal`.
- Version 23 added `refund_match_reviews`: what the matcher decided about each
  incoming credit, so a decision is not recomputed on every pass.
- Version 24 added `refund_questions`: the question, its numbered options, its
  state and the owner's answer.
- Version 26 took back the `non_personal` classification that linking used to
  write on the credit, for every link whose credit was still exactly as the link
  left it.
- Version 27 added `refund_match_reviews.rules_version`, so a decision made by an
  older edition of the rules is reconsidered.

## Known limits

A partial refund against several charges that are filed the same way — same
merchant, same kind, same category — attaches to the latest of them, which is the
purchase a cancellation usually follows. That is correct for every total and
every category figure, and wrong only if someone inspects that single purchase
expecting a different parent. Where the possible parents are filed differently
the choice would move money between categories, and it is asked about instead.

Exact matching on the original amount misses a reversal a merchant issues at a
slightly different amount. Those become questions rather than being absorbed by a
tolerance, because any tolerance wide enough to catch them would eventually merge
two genuine purchases.

A cross-currency link is approximate by construction: it uses the daily rate for
the day the money arrived, so the result moves if that rate is later corrected,
and it is displayed with a ≈ rather than as an exact figure.
