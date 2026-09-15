# ADR 0007: Refunds and reimbursements

Date: 2026-09-14. Status: accepted, amended by the owner the same day, and
implemented; not yet deployed. See [the refunds workflow](../refunds.md) for what
runs and the amendment at the end for what changed.

Money that comes back should reduce what a purchase actually cost. Today it does
not: reversals arrive as unexplained incoming payments, 389 of them are unresolved,
and the existing manual linking has produced 14 links in several months because it
demands an exact match on the ledger amount within 90 days.

## What the bank data actually shows

Three real cases decided this design.

**Epidemic Sound.** Charged 936.39 UAH on 3 August, refunded 928.85 UAH on
13 September. The ledger amounts differ by 7.54, but the original amounts are
identical: 17.99 EUR out, 17.99 EUR back. The difference is forty-one days of
exchange-rate movement on a card denominated in another currency.

**Bolt.** Original amounts again, over three days: 2.00 charged with 1.45 returned;
two charges of 10.00 with one fully reversed and 6.24 returned against the other;
5.20 charged with 5.19 returned. So a merchant reversal is sometimes exact,
sometimes partial, and sometimes a cent adrift. No reference to the original charge
is carried in the data.

**The same subscription on two accounts.** Epidemic Sound also bills the second
household member 8.99 EUR monthly on a different account. A matcher that ignored
which account was involved could reach across and reduce the wrong person's
subscription.

## Decision

**Match on the original amount and currency, never the ledger amount.** This is
what makes Epidemic Sound work at all, and it is the reason the present feature
finds so little: exchange-rate drift between a charge and its reversal is normal,
not exceptional.

**Automatic linking stays within one account.** A reversal lands on the card that
was charged. Requiring the same account is what keeps one member's refund away from
the other's identical subscription. Anything crossing accounts or people is only
ever linked by a person confirming it.

**A refund reduces the purchase; it does not erase or rewrite it.** The expense
keeps the amount the bank recorded and carries a reduction beside it. Spending
totals count the net figure, and the interface shows the original amount, the
reduction and the result rather than silently displaying a number that appears on
no statement. Original bank records are never modified.

**Ask only when the answer would change something.** This is the governing rule,
and it came from the owner: the system should work it out itself wherever it can.

- One candidate, exact original amount, same account and merchant, opposite
  direction, within roughly four months: link it, say nothing.
- A partial refund with exactly one outstanding charge larger than it: link it, say
  nothing. This covers a scooter ride charged at 2.00 and refunded 1.45.
- Several candidates that are **indistinguishable** — two identical charges of
  10.00 on the same day — are linked to the oldest unreduced one without asking.
  Which one is chosen cannot change any total, any category or any period figure,
  so the question would have no meaningful answer.
- Several candidates that **differ** are asked about, because the choice decides
  which purchase shrinks.
- A merchant reversal that is unclear, including one a cent adrift from its likely
  parent, is asked about rather than guessed.
- Money arriving from a person is always asked about; there is no merchant to
  reason from and only the owner knows which expense it settles.
- Nothing plausible at all: it stays visible as unresolved incoming money with a
  link into the application, so it can be attached by hand. It is never quietly
  netted and never hidden.

**Questions go through the existing Telegram flow**, and only for new money. The
backlog is not worth interrogating the owner about.

**A link is never undone automatically.** Corrections, later settlement or a
changed amount may make a link look imperfect, but an automatic reversal of a
human-visible decision is worse than an imperfect link. This follows the same
principle as attached receipts: keep the association, surface the disagreement.

## Consequences

Most merchant reversals will resolve silently, which is what the owner asked for.
Telegram questions become mostly about money from people, which is exactly the case
that genuinely needs a human.

Two limits are accepted deliberately. A partial refund against several identical
charges is attached to one of them arbitrarily, which is correct for every total
and wrong only if someone inspects that single purchase expecting a different
parent. And exact matching on the original amount will miss a reversal that a
merchant issues at a slightly different amount; those surface as questions rather
than being absorbed by a tolerance, because any tolerance wide enough to catch them
is wide enough to merge two genuine purchases eventually.

The 389 unresolved incoming payments are not addressed by this decision. Automatic
matching will explain some of them as it runs, and the rest remain visible.

## Amendment, September 14, 2026

The owner read the first implementation and corrected three things. These replace
the corresponding statements above.

**A linked credit is neither classified nor listed.** The original decision left
the credit visible and marked it `non_personal`. The owner's objection: it is
already counted through the purchase it reduced, so listing it shows the same
money twice, and "we don't need to categorize incoming transactions". Linking now
writes nothing to the credit, and browsing leaves it out.

**The result is settled in the account's currency, then converted like anything
else.** The original decision converted each side on its own date, which made a
charge and its reversal net to nothing in the merchant's currency and hid the
exchange-rate difference from every display except the account's own. The owner
asked for the plain rule instead: search on the original amount, compute the
result in the account currency, "and then treated the same way as other
transactions: count in other currency according to rates".

**A refunded purchase still has to be categorised.** The first implementation
dropped a fully refunded purchase out of the review queue on the grounds that it
cost nothing. What the money was for does not change because it came back, so the
purchase stays in the queue and in the list; only the credit disappears.

Two smaller consequences follow. A manual link may now cross currencies: the
incoming amount is converted into the purchase's currency at the daily rate for
the day it arrived, the view shows the paid amount, the returned amount as it
arrived and an approximate result, and analytics uses the result. And automatic
matching covers the historical backlog, not only new money — every confident link
is made without asking, while questions stay limited to money that arrives from
now on, because the owner will attach older ones by hand if they matter.

## Second amendment, September 14, 2026

Two more corrections from the owner after seeing the matcher run on real data.

**Money the bank is still holding is matched now, and the link follows the
settlement.** The first implementation refused to link anything pending, on the
grounds that a hold can still change. The owner's instruction: "i guess should
match and if and when its status will be changed — we will change our linkage too
if necessary (remove if needed or recalculate)". So a hold is linked, the link is
marked provisional, and when the bank settles the amount the reduction is
recalculated from what it finally recorded; a hold released without settling
takes its link with it. This is the single case where a link is undone without a
person, and it is allowed because the link was provisional by construction. A
correction to two already-settled amounts is still only surfaced, never undone.

**A reversal a whisker away from exactly one outstanding charge is linked.** The
original decision refused any tolerance, on the argument that a band wide enough
to catch a cent-adrift reversal would eventually merge two genuine purchases. The
owner saw the consequence — a Bolt ride charged at 5.20 EUR and returned at 5.19
sitting in the list unlinked — and asked for it to match. The rule that replaces
the refusal is not a band but a uniqueness test: a gap of at most three minor
units or one per cent, and it decides nothing unless exactly one candidate is
inside it. Two candidates equally close is still a question, and no weaker rule
may reach past them to a larger charge.

## Third amendment, September 14, 2026

The owner asked for the general case rather than the reported one: "We need to
link all the bolt refunds properly. and ideally all the refunds from other
merchants too." Measured against the real ledger, 107 of 137 merchant reversals
were linked automatically; the rest were partial refunds whose returned amount
matched no single charge, with several charges from the same merchant large
enough to absorb them.

**A partial refund whose possible parents are all filed the same way goes to the
latest of them.** Where every candidate shares the merchant, the movement kind
and the category, which one shrinks changes no total and no category figure —
only which row displays the reduction — and the latest charge before the refund
is the purchase a cancellation follows. This widens the trade-off the original
decision already accepted for charges nobody could tell apart. Where the
candidates are filed differently the choice would move money between categories,
and it stays a question.

## Fourth amendment, September 14, 2026

The owner supplied ride receipts for a week of Bolt journeys, which is ground
truth the bank data cannot provide, and two rules changed because of it.

**A refund goes to the nearest charge before it, not the oldest.** The original
decision linked an exact-amount refund to the oldest indistinguishable charge,
on the reasoning that the choice could not change any total. Two identical ten
euro holds proved otherwise: one ride ran from 14:03 to 14:18 and cost 3.76, the
other was hailed at 14:15 and cancelled at 14:16. Linking to the oldest gave each
row the other's story. Totals were unaffected, as predicted, but the two
purchases were wrong, and a person reading them would have been misled.

**Refunds are assigned as a set.** Deciding one refund at a time in arrival order
lets a partial refund take the charge an exact refund needed. Credits that name
their parent exactly now claim it first, and only then do the remaining ones
guess. The owner raised this before it was observed: "there might be one
transaction that we linked incorrectly, and the new one might not fit another
money out transaction anymore that was the right one."

The evidence question was settled at the same time, against the whole ledger
rather than three examples. Monobank records `receiptId` on 3,212 of 3,507
charges and on none of the 137 reversals; two reversal descriptions in 137
contain any digit; ten Enable Banking credits carry a `reference_number` and none
of them matches a debit. Nothing in the bank data says which charge a refund
belongs to, so amount, merchant, account, time and direction remain the entire
evidence base.

## Fifth amendment, September 14, 2026

The rule that a link is never undone automatically was written to protect a
person's decision, and it was also protecting the matcher's own guesses from
correction. When the nearest-charge and set-assignment rules landed, the two links
the owner's receipts had shown to be the wrong way round could not be fixed by any
rule change, because nothing re-examines an existing link.

**The matcher may release and redo its own unconfirmed links when the rules that
made them have changed.** Each automatic link records the rules edition that chose
its parent; when the edition moves on, those links are released with an audit
entry and the following pass assigns the set again. A link a person confirmed is
never released, nor is one whose credit or purchase a person has classified. The
owner approved this narrowly: "agree on last suggestion".
