# ADR 0008: The attributes of a payment, and one pipeline that fills them

Date: 2026-09-14. Status: accepted, not yet implemented. The ordered work is in
[the classification work plan](../classification-work-plan.md); the analytics
view that makes the result visible is designed in [analytics](../analytics.md).

This amends [ADR 0006](0006-classifying-what-money-was-for.md), which remains
the record of why there is one shared tree with one leaf per payment. It
supersedes three parts of it, named at the end: the "Exceptional" attribute, the
`Communication` branch kept in "As built", and the `Travel transport` leaf. It
does not reopen the decisions the owner has already taken; they are restated
here only where the design rests on them.

## Where the work is stuck, in figures

Measured on the live database on September 14, 2026.

Of 3,911 payments, 2026 outflows on accounts marked personal number 2,348: 1,920
are already personal expenses, 34 internal transfers, 10 business, 6 investments,
and **378 unresolved**. So 84% of this year's personal-account spending is
categorised and the owner's whole experience of "hundreds of uncategorised
payments" is those 378. They are not mysterious. 370 carry a merchant category
code, and the codes are concentrated: 120 are money transfers, 26 advertising,
22 charity, 15 utilities, 15 marketplace, 11 general merchandise, 10 restaurants,
7 ATM withdrawals, 7 recreation, then a tail. Roughly 120 are transfers with
nothing to reason from, and roughly 250 carry evidence that decides at least the
branch.

The model has not cleared them because it is under-informed, not because the
bar is high. 441 unresolved outflows carry a stored suggestion; at the 0.95
auto-apply bar exactly one is a personal expense, 0.90 would add 36, 0.70 would
add 114, and on 167 the model itself answers "unresolved". It sees four redacted
context fields, the code and its meaning, the account purpose, and past
decisions for the _exact same description_. It returns kind, category,
confidence and an explanation, never a tag. September spent 2,695 requests on
that slice.

The rules have the opposite problem. 517 are active and every one matches
something, but 324 match exactly one payment and always will, because a rule
matches a whole description by equality and a description that carries a
reference number is new every visit. 110 are the same matcher held once per
owner, which the shared tree made redundant. 34 rules do more than half of all
rule work.

Merchant identity, measured before anything was built on it, is reliable:
3,862 of 3,911 descriptions yield a merchant key, 771 distinct merchants, and of
588 clusters holding a categorised payment 561 agree on one leaf — 95.4%. The 27
that disagree are mostly one purpose filed at two precisions or a cluster still
half-classified; two are payment processors whose real merchant never appears;
one app genuinely is two businesses.

## Decision A — the attributes, as a whole

A payment carries four decided attributes and two that come with it from the
bank. Nothing else is stored as a decision.

**Kind** answers "does this count as household spending?" and is unchanged:
personal expense, internal transfer, investment, business, unresolved, with the
three-state visibility ADR 0006 gave it. This is the business-versus-personal
dimension the owner named, and Investment stays an explicit kind rather than a
tag, as already decided.

**Category** answers "what was it for?" and sums. One leaf of the one shared
tree, exactly as ADR 0006 built it. The tree is reconciled with the owner's list
below; the principle is untouched.

**Tags** answer every other "which of these was it?" that does not sum. Many per
payment, a household list, the owner's to define. Two things move here.
_Exceptional_ becomes a tag, replacing `spending_pattern` (the argument follows).
_Trip_ will be a tag with an optional date range and a business-or-rest purpose,
as CAT-6 already concluded, not a table of its own — recorded so the schema for
tags leaves room for two optional columns and nothing else needs to change when
trips arrive. Tags are never set by the model in this design; they are how the
owner marks what the evidence cannot show.

**Owner and account** are columns on the payment and both are filters; the
account filter is missing from the API today and is added.

Two attributes are _derived_, never stored as decisions, and exist so the
pipeline and the analytics can use them. **Counterparty identity** is what a
payment's other side resolves to: one of the household's own registered
accounts (by the identifier hash `own_accounts` already keeps), a merchant (the
merchant key `src/merchant-clustering.ts` computes from the description), or an
unknown person. **Merchant key** is the second of those, cached on the payment
for grouping and lookup but recomputable from the description at any time. A
change to the stop-word list re-derives both; no decision is lost.

### Exceptional becomes a tag

The owner asked whether `spending_pattern` deserves to exist or should be a tag,
and could not say from the architecture. The answer is a tag, for three reasons
that have nothing to do with taste.

First, it is what the owner uses it for. Every use case names "exclude
exceptional", never "show only reviewed-routine". Exceptional is a mark on a few
large purchases, not a review state of every payment.

Second, the three-state design is a fiction in practice. Nobody will mark two
thousand grocery runs "routine", so nearly every payment sits in "unreviewed"
forever and the "routine" state carries no information that absence does not.
The one thing the tristate buys — a count of never-reviewed payments — is
answered better by the coverage view in [analytics](../analytics.md), which says
who decided each payment.

Third, it removes a whole mechanism. `spending_patterns` is its own table with
its own revision scheme, its own audit event, its own filter parameter, its own
section in report snapshots and its own control on the review screen. Trips
would have needed a fourth mechanism. One tag list with one filter grammar
serves exceptional, trips and whatever the owner invents next.

What is given up: the audited reason text on a pattern change, and the
"not reviewed" state. Tag membership changes gain an audit event so the first is
recovered; the second is deliberately dropped. Report snapshots move from
`byPattern` to `byTag` under a new format version; old snapshots stay immutable.
Existing `exceptional` annotations become the tag; `routine` and `unreviewed`
rows are discarded because absence now means exactly what they meant.

### The tree, reconciled with the owner's list

The owner listed the categories they think in. Most already exist under a
different name or one level down, and a rename costs nothing because the stored
path is derived from the node. Only a change of `category_id` moves payments,
and every one is written to the audit trail as `category_moved`.

Kept as built, because the owner's item is already a node or a roll-up of one:
Food with Groceries and Restaurants (Dining in, Delivery — "seeing delivery
separately" is the leaf); Beauty; Pets; Donations; Gifts; Sport; Clothes;
Electronics; Education; Entertainment with Hobbies beneath it (the owner listed
"hobby" and "fun and entertainment" separately, and the roll-up gives both);
Home / Goods for "home expenses such as shelves"; Post & logistics; Apps &
services; Travel; Family / Parents support for "help parents".

**Psychotherapy stays a leaf of Health.** The owner wants it "under medicine
expenses, but visible separately", and that is what a leaf of the Health branch
is: its own line, and part of the branch total. Making it a child of the
`Medical` leaf would turn Medical into a branch, move its payments to a new
`Medical / Unspecified`, and give the owner nothing they do not have. "Medicine"
and "Health" are the same branch; the name can change for free if they prefer.

**`Ride-hailing` keeps its name.** This ADR first proposed renaming it to
`Taxi`, the owner's own word, and the owner declined: "no need renaming… I want
you to treat my use cases carefully. But no need exact names." Their definition —
taxis, scooters, car sharing, on-demand cars — already is the leaf's scope, so
the rename bought a question they could already answer and cost documentation and
review attention. The general rule, which applies to every name in this document:
read the owner's category lists as descriptions of the questions they want
answered, not as naming instructions. A question that cannot be answered is a
defect; a name that differs from their wording is not.

**Utilities becomes a branch of its own, and takes communication with it.** The
owner listed "utility bills, including all utilities — possibly communications
such as a phone top-up" as one thing and "home expenses such as shelves" as
another, so the shipped shape, where Utilities is a leaf inside Home and phone
and internet are a separate `Communication` branch, answers neither total. The
new branch is `Utilities` with leaves `Housing utilities` (the former
Home / Utilities node, reparented and renamed), `Mobile phone`, `Internet`, and
`Unspecified` (the former Communication nodes, reparented). Every one of these
is a reparent of an existing node, so no payment changes `category_id`, no rule
changes target, and the phone top-up signal in triage, which finds the leaf by
its name, keeps working. The `Communication` branch is deleted once empty. This
supersedes the "As built" deviation in ADR 0006 that kept Communication: the
reason given there — not losing a distinction the data already makes — is
satisfied by keeping Mobile phone and Internet as leaves; only the roll-up
changes, and it changes to the one the owner asked for.

**Flights and carpool are transport, so `Travel / Travel transport` is
retired.** The owner placed carpool "under transportation along with flight
tickets". ADR 0006 had put flights in a Travel leaf; that leaf's payments move to
`Transport / Long distance`, which already holds trains and buses, and the leaf
is removed. This is the one move that rewrites `category_id`. Its cost is that
the Travel branch total no longer includes flights, so "how much on trips in
general" is Travel plus Long distance rather than one branch — which the
analytics view answers by selecting both, and which the trip tag will answer
properly later. The trade is accepted because the owner's placement was
explicit and because a category that means "transport, but while travelling"
was a trip attribute pretending to be a category.

Everything else the owner did not mention — Rent, Repairs, Home / Services,
Alcohol, the Car subtree, Public transport — stays. The owner said plainly not
everything need be a category; unused leaves are listed by
`scripts/category-diagnosis.sql` and can be removed later, which reassigns and
never orphans.

## Decision C — one pipeline, in the owner's order

The owner described the process they want: rules first, sometimes by merchant
and sometimes by counterparty combined with account digits; then smarter
deterministic classification from merchant name and description; then AI for
what is left; if AI is confident, done; if not, ask — "for example, for some
payments, it is just IBAN transfer with no comments". They also said the system
must not depend on knowing every merchant in advance, because a new merchant
would always be uncategorised.

The pipeline is exactly that, as ordered stages. Each stage either decides,
abstains, or produces a provisional placement, and every stage writes what it
saw to the decision's provenance so the owner can inspect it (CAT-9). The first
stage to decide wins. There is one pipeline: the importer, a Telegram reply, an
explanation typed in the app and a newly attached receipt all run the same
stages over the same evidence bundle, differing only in what evidence is
present. This is what CAT-8 asked for, and it is why the receipt lane and the
explanation lane stop being separate classifiers.

**1. Account policy.** Already a database trigger: an outflow on a business or
investment account is that kind until a person says otherwise. Unchanged.

**2. Identity.** The counterparty's account identifier, hashed as `own_accounts`
hashes its own, matches a registered household account: an internal transfer,
or the target account's purpose when that is investment or business. This is
how a transfer to Kate's account is recognised, and it is the owner's
"counterparty combined with IBAN". `Accounts.suggestions()` already computes it
and today only _suggests_ it on the review screen; the pipeline applies it.
Prerequisite: every household account has its identifier registered, which the
bank connectors can do from provider account metadata rather than by hand. An
ambiguous match — two registered accounts, or the payment's own account —
abstains.

**3. Rules.** Owner-authored, household-scoped, and few. A rule is a set of
conditions that must all hold and an outcome: kind, leaf, optional tags. The
conditions are the evidence the owner named — merchant key, words that must
appear in the description, counterparty identifier hash, card suffix (valid only
together with another condition, since a suffix alone identifies nothing), code,
direction, account or owner, currency, and an amount range as supporting
evidence only. The legacy exact-description matcher survives as one more
condition type so the existing rules keep working until consolidated. Rules
apply at any amount, because the owner wrote them.

**4. Memory.** The merchant key of the payment is looked up across the
household's past decisions on non-excluded accounts. If every prior decision
for that merchant agrees on one kind and leaf, and either one of them was a
person's or at least two were automatic, the payment takes the same decision,
with provenance pointing at the decisions it reused. If they disagree, or the
key is a known payment processor, memory abstains and says why. This replaces
the exact-description `model_cache` and is the "second payment from the same
merchant" the owner floated — but as a _reading of past decisions_, not a rule
row. It costs nothing per payment, it cannot drift from what the owner has
confirmed, and correcting any one payment corrects the merchant, because
memory is recomputed, not stored. Measured purity of 95.4% is the reason this
is safe, and the abstain-on-disagreement rule is what keeps the 27 mixed
clusters from doing harm.

**5. Model.** Only when the deterministic stages have not decided. The request
carries the widened evidence the owner approved: the full description, amount,
currency, direction and date; the code and its meaning; the account's label and
purpose; the merchant key and every past decision for that merchant, not only
for the exact string; the linked receipt's lines when there is one; the owner's
own explanation when they wrote one; and the resolved counterparty identity —
"one of your own accounts", "a household member's account", "a person, not a
registered account", "a merchant" — in place of any identifier. Account
identifiers are redacted by the existing patterns and structured party-name
fields are not sent, because a known counterparty was already decided at stage
2 or 3 and an unknown person's name gives the model nothing. Health detail may
be sent; the owner said so. `store: false` stays. The output schema is
unchanged: kind, leaf, confidence, explanation. No tags.

**6. The line, and the ask.** Below 3,000 UAH (`reviewPriority`), a confident
decision from stages 4 or 5 is applied quietly. Above it, a decision from
stages 4 or 5 is applied _provisionally_ and, if the money is new, asked about
over Telegram — with one refinement: a memory decision backed by a person's own
earlier decision for the same merchant is not asked about, because the owner
has already answered. Stages 2 and 3 apply at any amount. Questions are only
ever about money booked after the rollout boundary (`TELEGRAM_LIVE_QUESTIONS_FROM`,
already enforced); the backlog is never asked about.

**7. The resting place.** Every booked outflow on an account marked personal
that no stage has decided is a personal expense — that is what the owner said
the data means — and it rests on the most specific category the evidence
supports: the leaf the merchant code maps to (the `MCC_CATEGORY` table the
version 25 migration already uses), else the model's leaf when it proposed one
at 0.7 or above, else the root `Unspecified`. A money-transfer code with no
comment rests in `Unspecified` as a personal expense, exactly as decided. The
placement is marked **provisional**: counted in every total, shown as a
category, and flagged as undecided wherever the payment appears. Provisional
placements stay in the pipeline — a later receipt, explanation, rule or model
run replaces them — and the model stage runs for them when budget allows.
Accounts whose purpose is still `unreviewed` are excluded: the argument "a
personal account holds personal spending" does not hold for an account nobody
has described, so those stay unresolved and visible.

Two columns carry this: `transactions.provisional boolean` and
`transactions.classification_source` (`human`, `identity`, `rule`, `memory`,
`model`, `mcc`, `default`, `account_policy`, `none`). The review queue becomes
"unresolved or provisional"; the incompleteness figure on Home and Analytics
becomes "unresolved, plus provisional" rather than "awaiting classification";
and the coverage strip in analytics can say what share of the money each source
decided, which is the deterministic form of the owner's "trust 90–95%".

Applied to the backlog in one migration, the resting place turns the 378 into
personal expenses at once: about 250 land on a real branch from their code, and
about 120 transfers plus the unmapped codes land in `Unspecified`. The root
catch-all grows, visibly, and the 2026 personal total becomes complete. That is
the smallest change that makes 2026 trustworthy without the owner reviewing
anything, and it is the first step of the work plan. The same sweep runs over
2025, because the argument does not depend on the year and a free default is
not the effort decision 6 declined.

### Should the model create rules? No.

The owner leaned against it — a rule database nobody can check — and floated
creating a rule on the second payment from a merchant. The recommendation is
that the model never creates a rule and that the second-payment idea is
implemented as stage 4, memory, which gives the same effect with nothing to
manage.

The reasoning is structural. A rule is a pin: a statement the owner makes that
overrides evidence, which is why rules run before memory and apply at any
amount. A model decision is evidence, and evidence belongs in memory, where a
correction to one payment corrects every future one and where nothing has to be
found and edited. Minting a rule from a confirmation is how 324 single-payment
rules came to exist, and the project has already decided to stop. A rule that
the model wrote and the owner never read is also a rule that generalises to all
future payments without anyone having agreed to that, which the invariants in
AGENTS.md forbid.

Rules therefore come from exactly two places: the owner writing one in
Categories & rules, and the owner ticking an explicit, default-off "also pin
this for <merchant>" when confirming a payment. The pipeline may _suggest_ a
rule in one situation only — when memory keeps abstaining for a merchant because
the owner has classified it two ways — and the suggestion appears in settings,
not as a created rule.

### The existing 517 rules

Rules become household-scoped: the tree is shared, a merchant means the same
thing to both members, and the 110 duplicates are proof the owner scope was
already fiction. Where a rule genuinely depends on whose account it is, that
becomes an explicit account or owner _condition_, which is more honest than an
implicit scope. The migration merges identical cross-owner pairs into one rule,
keeps disagreeing pairs as two owner-conditioned rules and reports how many
those were, and records every merge in `classification_rule_audit`.

The 324 single-payment exact-description rules are handled by the decision
already taken: consolidation is the classifier's work, not a hand review. A rule
whose only matching payment already carries the same decision adds nothing that
memory does not, so it is _retired_ — deactivated with a reason, never deleted —
automatically, because retiring it changes no payment's classification and
memory reproduces its effect on any future variant of the description. Rules
that reach several payments, and the counterparty rules, are grouped by merchant
key; where a group agrees, one merchant-key rule is proposed to replace it, and
the proposals are confirmed in bulk from one screen because a merged rule
generalises to descriptions the owner never saw. The expected end state is the
"manageable core" of roughly 200 rules, mostly merchant and counterparty pins.

## What the model costs under the widened evidence

The cap stays at $10 until OPS-5 measures the real figure; this is the estimate
the design was checked against, not a measurement. A widened request is on the
order of 1,500 input tokens and 150 output tokens; at the listed prices for the
pinned model that is about $0.002 settled, and the reservation is the
worst-case `maxInputChars` plus the output ceiling, so the gate admits fewer
requests than that at any moment. The ledger receives roughly 330 payments a
month; identity, rules and memory decide most of them for nothing, so the model
sees perhaps a third — around $0.20 a month at the estimate — and the 378
backlog costs under $1 once. The September figure of 2,695 requests was a
backlog pass on the narrow slice, not a running rate, and memory exists
precisely so it does not recur. Prompt caching of the instruction and the tree
vocabulary is worth enabling but the design does not depend on it.

## Consequences, including what is given up

Most new payments are classified by identity, rules or memory without a model
call and without a question. Questions become what the owner described: an
IBAN transfer with no comment, above the line, on new money. The historical
backlog is placed, not interrogated.

The 2026 personal total is complete on the day the resting place lands, and it
is _less accurate_ than the categorised 84% it joins: roughly 120 transfers to
people are counted as personal spending in `Unspecified` until the owner says
otherwise, and a transfer to an own account whose identifier was never
registered would be among them. The owner accepted this explicitly, and the
provisional flag keeps the boundary visible so that the catch-all can be seen
falling as identity registration, rules and memory catch up.

Exceptional loses its "not reviewed" state and its reason text; tags gain an
audit trail. Report snapshots change format.

Two category moves cost something: flights leave the Travel total, and the
Utilities branch changes what "Home" means. Both are the owner's stated
placements.

Memory can be wrong in the way any generalisation can: a merchant that starts
selling something else keeps its old leaf until the owner corrects one payment,
at which point memory abstains for that merchant and the model or the owner
decides. That is the intended failure mode, and it is why memory abstains
rather than votes.

Rules become more expressive and therefore harder to reason about when two
match. The design keeps today's answer — two matching rules with different
outcomes is an ambiguity that asks — rather than inventing a precedence order,
because the owner will have far fewer rules and the pipeline should surface a
conflict rather than resolve it silently.

Item-level splits are not foreclosed: the single leaf still belongs to the
payment, and a future split replaces the payment with parts that sum back to
it. Nothing here stores anything per line.

## What the owner settled, and two corrections already applied

This ADR was written with four questions open. The owner answered all four on
September 14, 2026 and they are folded into the decisions above rather than left
as a pending list: **Utilities becomes its own top-level branch** holding phone
and internet; **flights and carpool move to `Transport / Long distance`** and
`Travel / Travel transport` is retired, with the consequence accepted that the
Travel total excludes flights until the trip tag exists; the **resting-place
sweep covers 2025** as well as 2026; and `Ride-hailing` keeps its name.

Two corrections the owner authorised were applied to the live database straight
away, since neither waits on any of the work below. Each payment carries an audit
event naming the instruction, and a pre-change dump was taken first.

**Uklon is ride-hailing, not public transport.** Sixty payments were filed under
`Transport / Public transport`, fifty-six of them by hand, so this was a
consistent misreading rather than a slip; the owner corrected it and all sixty
moved to `Transport / Ride-hailing`, which now holds sixty-one. Worth keeping in
view as a warning about merchant memory: had memory existed, it would have learned
`Public transport` for this merchant from fifty-six agreeing human decisions and
been confidently wrong. Memory reproduces the owner's habits, including their
mistakes, so a correction must propagate to every payment of that merchant rather
than only to the one in front of them.

**Advertising bought from a personal card is business.** All twenty-six 2026
payments carrying merchant code 7311 on a personal account turned out to be
Katya's, none the owner's, and they are advertising she buys for the business, so
they became `non_personal`: about 29,000 UAH that was inflating personal
spending. This is the shape the owner described for the white Mono card in
reverse — business money on a personal account rather than personal money on a
business one — and it is the case the version 25 migration deliberately left to a
person, since no account purpose implies it.

Together these two took the unresolved 2026 outflows on personal accounts from
378 to 352 before any of the planned work starts.

## Amendments to ADR 0006

The following statements in ADR 0006 are superseded by this decision; the
remainder of that record stands.

- "**Exceptional.** … It is kept for now and may be dropped later" — the
  attribute is replaced by the household tag `Exceptional`; `spending_pattern`
  is removed.
- "As built … **Communication** is kept as a branch" — Communication is
  dissolved into the new `Utilities` branch beside `Housing utilities`.
- The tree's "**Travel** — Accommodation, Travel transport, Travel other" —
  `Travel transport` is retired; flights, trains, buses and carpool are
  `Transport / Long distance`.
- "Rules and learned merchants classify what they can, the rest stays
  unspecified" — the rest now _rests_ in the most specific category its
  evidence supports, as a provisional personal expense, and the catch-all is
  the least specific of those rather than the only one.

## Amendment, September 15, 2026: two counterparties the bank names itself

Decision 7 said that "a money-transfer code with no comment rests in
`Unspecified` as a personal expense, exactly as decided", and the consequences
section priced that at "roughly 120 transfers to people … counted as personal
spending until the owner says otherwise". The owner accepted that cost against
household-sized amounts.

Two kinds of payment carry a money-transfer code and are not household-sized.
Sole-trader tax paid to the State Treasury, which Monobank renders as
`ГУК <region>/<community>/<budget code>`, put 1,145,672 UAH into personal
spending across five payments — 880,894 of it on one day, which made a tax
payment the largest personal expense of the year and the owner's July total
1.58 million against a spreadsheet that says 369 thousand. Money moving to the
household's own cards, which the bank words as `Переказ на картку` and
accompanies with no counterparty at all, added 502,687 UAH across thirty-two.

Neither is a change of principle. The treasury is the "already known to be
business" carve-out this ADR names, and the ledger already disagreed with
itself about it: eleven of sixteen treasury payments were `non_personal` before
the sweep, and only the five nobody had reached became spending. The own-card
wording is weaker evidence — checked against the owner's spreadsheet, thirty-one
of the thirty-two are transfers between their own accounts and one is a payment
to a therapist's card — so it settles the payment as an internal transfer but
keeps it **provisional**, which leaves it in the review queue to confirm.

So the resting place now consults the description before the merchant code, for
these two counterparties only, and only when the payment names no counterparty
of its own; a stated IBAN, a typed comment or printed card digits all describe
somebody and are already matched a step earlier. Schema version 31 applies the
same two recognisers to everything the sweep had already placed, skipping any
payment a person has decided. Transfers to _people_ are untouched and still rest
in the catch-all, exactly as decided.

What is not addressed here is the general form of the problem: nothing stops a
placement whose amount is far outside the account's ordinary range from resting
silently in a catch-all. An 880,894 UAH `Unspecified` personal expense should
have asked rather than rested. That guard is a change to this decision rather
than a correction of it, and is left for the owner.
