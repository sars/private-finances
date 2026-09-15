# ADR 0005: Attach receipts to pending payments and show settlement differences

Date: 2026-09-13. Status: accepted.

## Decision

Automatic receipt matching accepts a payment that is still `pending`, not only a
`booked` one, for every bank. When the payment later settles and its amount or
currency differs from the receipt, the attachment is kept and the difference is
recorded and shown. A receipt is never detached automatically because a number
changed. If a separate booked row appears for the same purchase, the receipt moves
to it rather than being stranded on a row that never settles.

## Why the previous rule was wrong

Matching required `status='booked'` on the reasoning that a hold can still change.
Three things argue against it.

The evidence is already complete at purchase time: merchant, date, total and
currency all match when the photo arrives. Waiting adds no information in the
ordinary case, it only delays the owner's confirmation by days.

The rest of the system already accepts the pending case. Manual attachment works on
pending payments today, and receipt-informed categorization was explicitly changed
to apply to pending debits. Only automatic matching still waited, which was an
inconsistency rather than a principle.

The evidence does not support the fear. Every pending-to-booked settlement recorded
in production (14 at the time of this decision) kept the same transaction row and
the identical amount. The row is updated in place and its revision is incremented;
no separate booked row appeared.

## Why the link survives a settlement difference

An attachment records a fact about the world: this receipt is the evidence for this
purchase. That fact does not become false because the settled amount differs from
the printed total. Amounts legitimately move between authorization and settlement
through restaurant tips, fuel pre-authorizations and foreign-currency re-rating.

Detaching in those cases would discard correct evidence, automatically and
invisibly, which contradicts the project invariant that incomplete or uncertain
information is displayed separately rather than disappearing. So a difference is
surfaced for the owner to judge, and the association stands until a human changes
it. Automatic unlinking is reserved for a case where the association itself is
shown to be wrong, never for a case where a number moved.

## One rule for every bank

The rule is uniform: a receipt is matched to its purchase whatever the payment's
status and whatever the bank. A per-source exception would express "we trust this
bank's settlement behaviour" rather than the fact the rule is really about, which is
that a receipt belongs to a purchase.

The evidence supports this. Enable Banking has never produced a pending row: all 42
Wise and Revolut transactions recorded arrived already booked, so booked-only never
delayed anything for those accounts. Monobank is the opposite and shows a hold
within seconds, which is where the delay was actually felt.

## Re-attachment when a separate settled row appears

One risk remains. Enable Banking keys rows on the bank's `entry_reference`. If a
bank ever reported a pending entry and then changed that reference at settlement, a
second row would appear instead of the first being revised, leaving the receipt on
a row that never settles.

Rather than prevent that by refusing to match, the attachment follows the evidence.
When a receipt is attached to a payment that is still pending, and a booked payment
appears that matches the same receipt as well, the receipt moves to the booked row.
The move is recorded as an ordinary attachment event with its previous payment, so
the history shows what happened and why.

Three limits keep this safe. The receipt only moves away from a payment that is
still pending; a settled attachment is never second-guessed. It only moves when
exactly one booked candidate matches, and that candidate carries no receipt of its
own. And it never moves an attachment a person made by hand, because a human
decision outranks an automatic one.

Uniqueness is unchanged and still decides first: exactly one candidate must match
the date, total and currency across both owners, or nothing is linked. A pending
and a booked row for the same purchase existing together would present two
candidates and correctly refuse to link.

Existing protections are unchanged. A payment that already carries a matched
receipt never gains a second automatic link. Human decisions keep priority.
Money is never rewritten, and original bank records are never modified.
