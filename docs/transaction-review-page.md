# The transaction review page

The page at `/review?id=…` is where a single payment is decided. Since
September 17, 2026 it is one of two pages for a payment: this one leads with
the decision, and `/transactions/:id` leads with the facts and has no form.
Both open with the same header — description, amount, the moment, the account
badge and whose account it is, type, category, pattern and tags. On the review
page the decision block is the left, widest column, with everything already
said about the payment inside it above the explanation box, so an explanation
that did not work is in view when the next one is written; receipt, refunds and
the bank record sit beside it. On a phone everything flows in one column.

## Recognising the payment

The header carries the description, the amount, and then a row of facts that
each say what they are. Nothing on this page appears as a bare word: the type
and the category are labelled, and a payment with no category yet says so in
words rather than showing an empty space. `Unspecified` is a real leaf of the
category tree, so it is shown as the category it is rather than as a mysterious
tag beside the type.

The moment is the day and the clock time in Europe/Riga. A Monobank card charge
has a real time of day and shows it; a statement line from an aggregated account
and a cash entry record only a day, so only the day is shown rather than implying
a precision the record does not have.

Which account paid is a chip carrying a small coloured mark. The colour comes
from the name the owner gave the account, falling back to the currency — so
"Monobank black" is dark, "Monobank white" is pale, anything named
Revolut is violet and cash is amber. Renaming an account changes the text on the
chip and nothing else; the chip never decides which account a payment belongs
to. Direction is a mark with a tooltip and no text.

The chip never names the integration a payment arrived through. The household
banks with Monobank, Revolut and Wise, not with Enable Banking, so an aggregated
account is identified by the name the owner gave it and, failing that, by what
it holds — "USD account". Monobank is named only because it happens to be both
the connector and the bank. The connector belongs in system health, not here.

A payment the bank is still processing shows a quiet chip and a separate note.
The note says plainly that the money has already left the account and counts as
spending, and that the bank may still change the amount when it settles. This is
deliberately understated: a hold is ordinary spending, not a special state that
deserves the loudest badge on the page.

## Deciding

One form saves the whole decision: payment type, category, tags, whether the
payment was routine or exceptional, and the reason. **Ask in Telegram** sits
beside the explanation box, because that is the other way to answer the same
question.

Either member may open and decide the other's payment here, exactly as either
may answer a Telegram question addressed to the other. The payment stays on the
account it belongs to — the totals never move — and the record says who
actually decided: the audit event, the spending-pattern annotation, the refund
link and the explanation each carry the member who signed in, beside the member
whose payment it is.

The category and tag fields are type-to-search pickers built on Popover and
`cmdk`, grouped by top-level parent and showing the full path. They replace a
plain text input with an HTML `datalist`, which browsers render inconsistently
and which had degraded into a free-text box with no visible options.

Only a leaf that exists in the shared tree can be chosen. A payment is filed on
a node rather than on a string (ADR 0006), so an invented name would be rejected
on save with nothing useful to say; instead, a search that matches nothing offers
the link that adds a category.

A suggestion fills the tags in as well as the type and category, from the
household's own list and never by inventing a name; it adds to whatever the
payment already carries rather than replacing it, and stays a suggestion until
the decision is confirmed.

The pickers read `/api/categories` as it is actually returned: nodes carrying
`path` and `assignable`, and tags as their own list. An earlier local type
described nodes as carrying a `type` field they never had, so filtering on it
matched nothing and left both pickers permanently empty.

Confirming a decision raises the payment's revision, and the spending-pattern
endpoint checks that revision. So the combined save runs in a fixed order —
spending pattern, then tags, then the classification — and stops at the first
failure rather than leaving part of a decision applied.

### Routine and exceptional

The distinction stays a field on the payment rather than becoming a tag, because
its purpose is to be filtered on: the owner wants to find the payments that were
not part of ordinary life. A tag would mix that with tags that describe what the
payment was about. The transaction list therefore carries an **Exceptional only**
filter and shows an Exceptional badge on the rows.

Above roughly 500 EUR of equivalent value the form offers a hint that the
payment might be exceptional. It is only a prompt; nothing is decided from the
amount, and the thresholds live beside the control that uses them.

## Evidence

**Receipts** show the photo as a thumbnail next to the data read from it, so the
reading can be checked against the picture, with a link through to the full
receipt and all its items.

**Refunds** are one block, not two. It is closed by default, because the
headline amount already states what the payment finally cost; it opens
automatically when an incoming credit still needs to be attached to a purchase.
Inside are the amounts, each linked refund with how it was matched, any
discrepancy, the undo link and the history of the linkage. The history of the
payment itself is a separate link further down.

**The bank record** has two layers. The formatted layer shows only what helps
place a payment: the original purchase amount when it differs from the account
currency, the payment purpose or comment, the merchant category translated into
words, the counterparty's name, masked IBAN, masked card and bank, and cashback.
Direction, account, bank name, description, status and bank fee are not repeated
there — they are either already in the header or do not help identify anything.

Underneath, collapsed, is the complete field list as the bank sent it. It is the
same owner-scoped projection as before: only documented, explicitly selected
fields cross that boundary, so "raw" here means every field that is allowed out,
not a dump of the provider payload. The generic advisory sentences that used to
print regardless of content are gone; a note about an absent counterparty or
card appears only where that absence is what the record shows.

## Contracts

`/api/transaction-details` returns `fields` as before and adds `summary`, a
named projection of the same data: `originalAmount`, `purpose`, `mcc`,
`counterparty`, `cashback`, `bankTransactionType` and `valueDate`. The page
reads `summary`; it does not match on label strings.

`POST /tags` accepts `tagIds`, a comma-separated set that replaces the
transaction's tags, which is what a multi-select editor means by saving. The
older single `tagId` field still adds one tag and is what the plain HTML form
sends.
