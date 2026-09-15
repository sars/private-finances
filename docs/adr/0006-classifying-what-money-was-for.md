# ADR 0006: Classifying what money was for

Date: 2026-09-14. Status: accepted; the structure below is implemented in
schema version 25. See "As built" at the end for what changed in the doing.
Amended by [ADR 0008](0008-attributes-and-the-classification-pipeline.md),
which replaces the Exceptional attribute with a tag, dissolves the Communication
branch into Utilities, retires Travel transport and renames Ride-hailing; its
closing section lists each superseded statement.

This records what the owner wants from categorisation and the structure that
delivers it. It replaces the current arrangement, in which one hierarchy carries
several unrelated jobs at once and per-owner trees make family totals unreliable.

## The problem, from the owner's own examples

The owner wants to see real spending for a period with incoming money excluded and
investments excluded by default but includable; to filter to ordinary spending or
to exceptional spending; to see top categories and how a category moves over time
by day, week or month; to read a total at any level ("all food" as well as
"restaurants only", "all transport" as well as "taxi only", "health" as well as
"psychotherapy"); to filter by person, by account, and by both together; and to
drill from any number in an analytics view into the transactions behind it.

The present structure cannot answer these cleanly. Parents are used as leaves, so
`Health` holds 37 payments beside `Health / Psychotherapy`'s 38 and quietly means
"health, unspecified". `Subscriptions` and `Apps & services` are the same idea
split in two across 258 payments, so neither total is trustworthy. `Shopping` and
`Delivery` name a shop or a courier rather than a purpose. Category trees are keyed
by owner, so the two members can drift apart and a household total by category is
not guaranteed to mean anything.

## Decision

**One category per payment, and every payment has one.** Categories are the axis
that sums: every personal expense in a period belongs to exactly one, so any total
is unambiguous and nothing is counted twice. Everything else the owner wants to
slice by is a separate attribute, not a category.

**One shared tree for the household.** Both members classify into the same
structure. A per-person tree makes a family total by category meaningless, and the
owner has asked for the same structure for everyone.

**Roll-up is a reading of the tree, not a separate concept.** "All food" is the sum
of Food and everything beneath it; "restaurants only" is one node. The same stored
data answers both, chosen when the report is drawn rather than when the payment is
classified.

**Parents stop being assignable.** A payment is filed on a leaf. Where something
genuinely belongs to a parent and no existing leaf fits, it goes to that branch's
own unspecified leaf, which is visible and countable, rather than silently resting
on the parent. This is what stops "Health" from meaning two different things.

**Depth follows the owner's examples and stops at three.** Most branches need two
levels. Three is used only where the owner asked for a distinction inside a
distinction, which in practice means transport: fuel must be readable on its own,
as part of car costs, and as part of all transport.

## The tree

Proposed from the owner's description; names and membership are theirs to adjust,
and the structure is meant to be changed as understanding improves rather than
fixed forever.

- **Food** — Restaurants (with Delivery beneath it, since ordering a meal is eating
  out by another route), Groceries, Alcohol if it is ever bought separately
- **Home** — Rent, Utilities, Goods, Services such as cleaning, Repairs
- **Transport** — Car (Fuel, Maintenance, Parking, Insurance), Ride-hailing (taxi,
  scooters, car sharing), Public transport, Long distance (flights, trains, buses)
- **Health** — Psychotherapy, Medical, Pharmacy, Unspecified
- **Sport** — Gym, Racket sports, Volleyball, Dance, Unspecified
- **Beauty** — Cosmetics, Services
- **Clothes**
- **Electronics**
- **Apps & services** — absorbing the present Subscriptions, since they are one idea
- **Education** — Courses, Materials
- **Entertainment** — Events, Hobbies (board games, books)
- **Pets**
- **Gifts**
- **Family** — Parents support
- **Donations**
- **Post & logistics** — parcels and courier shipments, not food delivery
- **Travel** — Accommodation, Travel transport, Travel other
- **Unspecified**

`Travel` remains a category for purchases that exist only because of travelling,
such as a hotel. It does not attempt to hold a trip's food or taxis; that is the
trip attribute's job, described next.

## Attributes, which do not sum

These are the other ways the owner wants to slice the same money. None of them is a
category, and none of them is added to a category total.

**Owner and account.** Both already exist on every payment and both are things the
owner wants to filter and group by, including a specific card or a
currency-specific account. The owner follows the account by default and can be
overridden per payment.

**Kind.** Whether the money counts as household spending at all: a personal
expense, an internal transfer, an investment, a business expense that is
compensated later, or unresolved. Business expenses that come back are their own
kind and never count as household spending, by the owner's decision.

**Trip.** A named, dated thing a payment can belong to. The owner's definition is
decisive and narrower than a date range: a trip holds what was spent **for** the
trip, not everything that happened while away. So a trip is assigned deliberately,
never derived from dates, and a normal grocery run at home during a trip stays out
of it.

A trip total is a different question from a category total and the two are never
added together. A dinner in Rome is Food / Restaurants and also part of the Rome
trip; it is counted once in food spending and once in the trip's cost, and those
two numbers answer different questions.

**Exceptional.** Whether a payment is ordinary or exceptional, in the owner's sense
of out of the ordinary rather than non-recurring. Exceptional purchases tend to be
large. This is a property of the payment, not of its category, because the same
category holds both an ordinary weekly shop and an unusual one. It is kept for now
and may be dropped later if it does not earn its place; nothing else should depend
on it structurally.

**Tags.** Free-form and many per payment, for groupings that do not deserve a
category and are not worth maintaining rigorously.

## Showing and hiding

Exclusion has three states rather than two, because the owner wants investments out
of the headline figure but still reachable.

A payment either counts toward spending, or is excluded from totals while
remaining visible and includable on request, or is hidden. Investments and
compensated business expenses sit in the middle state: absent from the headline
number by default, present the moment the owner asks for them. Nothing is deleted
to achieve this, and no exclusion is silent.

## Unspecified

A catch-all is kept. The owner's objection is that it says nothing, not that it
should not exist, so the aim is to shrink its use rather than remove the bucket.

It is visible in analytics, never hidden, and its size is worth showing over time
so that it can be seen falling. Each branch carries its own unspecified leaf, so an
unclassified health payment is at least known to be health. When a category is
removed its payments are reassigned rather than orphaned.

The 2025 history is not worth classifying by hand; the owner does not remember
those payments, and their value is in trends rather than per-payment accuracy.
Rules and learned merchants classify what they can, the rest stays unspecified, and
it is included in analytics so totals stay honest.

## Item-level detail is not foreclosed

The owner wants to ask how much was spent on a kind of product, alcohol being the
example, using receipt lines. A supermarket payment is one payment on one category
while its receipt spans several. That is deliberately left open: it may become a
separate lens over the same money, or a payment may be split into parts that
replace the whole and sum back to it. Nothing in this decision should prevent
either, and the single-category rule applies to the payment, not to a future
line item.

## What this costs

A single category per payment means a purchase that genuinely spans two categories
cannot be expressed without splitting it, which is why splitting is left open
above. Banning parents as assignable adds a step when no leaf fits, which is the
intended friction. A trip that must be assigned deliberately will be missed
sometimes, which is the price of counting only what was spent for the trip rather
than everything during it; making assignment cheap at the moment a payment is
reviewed matters more than any reporting feature built on top.

## As built

Schema version 25 replaces the two per-owner path hierarchies with one shared
tree. A payment now points at a node (`transactions.category_id`); the familiar
`transactions.category` path text remains, but the database derives it and
rejects any attempt to write it, so renaming a category never rewrites history
and every existing reader keeps working. Every payment's previous path is kept in
`category_migration_log`, so a mapping that turns out to be wrong can be found
rather than remembered.

Three invariants live in the database rather than in review prose, because a
constraint cannot drift between sessions: a payment cannot be filed on a node
that has children, the path mirror is always re-derived from the node, and depth
is computed from the parent and capped at three.
`scripts/category-diagnosis.sql` checks all of them against the real database and
reports how much is still Unspecified, month by month.

Two deliberate departures from the tree above. **Communication** is kept as a
branch, holding Mobile phone and Internet: both carry real volume and the
classifier already routes phone top-ups by name, so folding them into Home /
Utilities would lose a distinction the data already makes. **Restaurants** gained
a `Dining in` leaf beside `Delivery`, because a parent is not assignable and
restaurant spending needed somewhere of its own to land.

Where the migration cannot place a payment precisely it uses the merchant
category code the bank recorded — but only for a payment nobody has classified,
and only to replace Unspecified with something more specific, so it can never
overwrite a decision or make an answer worse. The rest stays Unspecified and
visible, which is what keeps the totals honest while its size falls.

### Account purpose stopped being applied at display time

Reporting used to rewrite a payment's kind, and blank its category, whenever the
account was a business or investment account. That conflated where the money sat
with what the money was: a grocery run charged to the business card became an
uncategorised business payment, and there was no way to say otherwise.

The conclusion is now recorded on the payment itself, once, with a reason in the
audit trail — when the payment arrives, and when the account's purpose changes.
Totals are unchanged, and the owner can mark a single payment personal, which
matters because most spending on the business card is business spending but some
of it is not. A payment a person has classified is never touched, an investment
bought from the work card keeps that attribution, and calling the account
personal again undoes exactly what the policy did.
