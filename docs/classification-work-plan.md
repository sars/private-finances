# Classification and analytics: the work, in order

Written September 14, 2026 to implement
[ADR 0008](adr/0008-attributes-and-the-classification-pipeline.md) and
[analytics](analytics.md). Each step is one branch, one PR, one verified
increment, merged by the supervising agent when CI is green and released with
`deploy/release.sh`. Steps name the files they touch so that two agents do not
edit the same module at once; the parallelism notes say which steps may run in
separate worktrees at the same time. Schema versions are assigned at merge:
the plan assumes the next free is 28 and counts up, but the number is whatever
`src/database.ts` says when the branch lands.

Every step ends with `pnpm check` and the tests it names. Every step that
migrates data is rehearsed on a restore of production into a disposable
database before release, as `release.sh` already does, and its acceptance query
is checked in to `scripts/category-diagnosis.sql` so the result is read from
the database, not from a screenshot.

Difficulty is noted per step for model routing: **bounded** steps are ordinary
coding against a precise spec; **hard** steps cut across modules or change
financial semantics and warrant the stronger coding tier.

## D — the immediate data problem (first, and small)

**D1. Register own-account identifiers from provider metadata.** Bounded.
`src/bank-sync.ts`, connector adapters under `src/connectors/`, `src/accounts.ts`.
When a connector lists an account it already knows the account's IBAN (Enable
Banking account details; Monobank client info). Register its hash on the
`own_accounts` row through the existing `identifierHash` path, keeping an
identifier the owner typed (`COALESCE` already does). No new table. Delivers:
every household account carries an identifier hash without the owner typing
IBANs, so a transfer to Kate's account is recognisable. Verify: a synthetic
sync registers the hash, a second sync is idempotent, a hand-registered hash is
not overwritten (`test/accounts.test.ts`, `test/bank-sync.test.ts`); the
diagnosis SQL reports `own_accounts` rows with and without a hash — the target
is zero without.

**D1a. As built: identified by what the owner has said.** Done.
`src/counterparty-identity.ts`, migration 30. D1 was implemented and measured,
and the measurement undercut its premise. Of 587 outgoing money-transfer
payments on production only about a third carry a counterparty IBAN, and a
masked card number appears on 38 payments in a ledger of 4,064 — across 28
distinct cards, 22 of which appear exactly once, because the number a bank
prints is the *other* party's card and the other party is usually a stranger
paid once.

So the ordinary case is a bare name, and a name cannot be verified: the bank
gives no account behind it. It is treated as a statement the owner has made,
taken from two places that ask nothing new of them. The classification rules
they already wrote supply the counterparties they declared (six on production,
reaching 127 payments). And whenever they categorise a transfer by hand it is
remembered, so the next payment to the same person is answered without them —
their own plan for this was "if any problem — i can manually recategorize it",
and remembering it means once rather than monthly. Deciding a transfer was
spending after all un-teaches it.

Matching is on a normalised key, which is why this is a table rather than more
rules: a rule compares the bank's string exactly, so `Kate Baeva`, `Катерина Б.`
and `КАТЕРИНА Б` would need three rules for one person and the list grows
without bound.

Matching by amount was built, measured and then removed at the owner's
instruction. The reason is decisive: the system does not hold every account of
the household, so the other half of a genuine transfer is frequently absent,
while a pair that does appear may be two unrelated payments of the same size.

Rehearsed against a restored production copy: 153ms, idempotent, every invariant
zero — no derived-path drift, no category left on non-spending money, no
hand-made decision overridden. Three payments corrected, the rest being
transfers already classified or genuine payments to other people.

**D2. Provisional placement: columns, sweep, and what reads them.** Hard —
changes what the totals mean. Migration 28 in `src/database.ts` with the logic
in a new `src/resting-place.ts`; readers in `src/domain.ts`, `src/analytics.ts`,
`src/spending-review.ts`, `src/transaction-triage.ts`, `src/clarification-cycle.ts`,
`src/repository.ts`, `frontend/src/Overview.tsx`, `frontend/src/Review.tsx`.

The migration adds `transactions.provisional boolean NOT NULL DEFAULT false`
and `transactions.classification_source text NOT NULL DEFAULT 'none'` with the
check list from the ADR, backfills `classification_source` from the latest
audit event (`classified` → `human`; `auto_classified` by policy → `rule`,
`model`, `account_policy`, `mcc` as the provenance says), then runs the sweep in
the ADR's order over booked outflows on accounts whose purpose is `personal`,
excluding payments with a `classified` event, a pending explanation, a matched
receipt awaiting the pipeline, `manual_cash`, and refund credits: first
identity (the `Accounts.suggestions()` computation, applied when unambiguous:
`internal_transfer`, or the target account's kind, `provisional=false`,
`source='identity'`); then the resting category (`MCC_CATEGORY` leaf, else a
stored `transaction_triage` model decision at ≥ 0.7 for the current revision,
else root `Unspecified`) as `personal_expense`, `provisional=true`,
`source='mcc'` or `'default'`. One `auto_classified` audit event per payment
with policy `resting_place:v1` and the reason it landed where it did.
`triage`'s `processOne` selection changes from `kind='unresolved'` to
"unresolved, or provisional with no model proposal for this revision", so the
placed payments still reach the model when the budget allows.
`queueDailyClarifications` selects the same set, still bounded by `liveFrom`, so
no historical placement becomes a question. `expenseSummary` and
`convertedSpending` count provisional personal expenses as spending and report
`provisionalMinor`/count alongside unresolved. Human classification and
confident automatic decisions set `provisional=false`.

Delivers the owner's ask directly: after release, 2026 personal-account outflows
have zero unresolved on accounts marked personal, the Home and Analytics totals
include them, and the review screen shows them with a "placed by default"
badge. Verify: `test/resting-place.test.ts` covers each exclusion, the identity
step beating the default, the MCC leaf beating `Unspecified`, the audit event,
idempotence on a second run, and that a human decision is never touched;
`test/migration-upgrade.test.ts` proves the migration applies to an
already-migrated schema; the diagnosis SQL gains three queries — unresolved
booked outflows on personal accounts (target 0), payments by
`classification_source` and `provisional`, and the `Unspecified` share by month
— and the rehearsal on the production restore is read from them.

**D3. Reconcile the tree.** Bounded. Migration 29; `src/category-tree.ts`
(seed), `src/category-migration.ts` (`MCC_CATEGORY`: 4900 stays on the same
node, which is now `Utilities / Housing utilities`), `src/transaction-triage.ts`
only to confirm the `Mobile phone` name lookup still resolves to one leaf. In
the ADR's terms: create the `utilities` branch; reparent `home.utilities`
(rename `Housing utilities`), `communication.mobile`, `communication.internet`
and `communication.unspecified` under it; delete `communication`; move payments
on `travel.transport` to `transport.long_distance` through the existing
`moveTransactions` path so each gets a `category_moved` event, repoint any rule,
delete the leaf; rename `transport.ride_hailing` to `Taxi`. Update
`CATEGORY_SEED` to the same shape, keeping moved nodes' slugs, so a fresh
database and production agree. Verify: `test/category-migration.test.ts` runs
the migration over a database seeded at version 25 and checks paths, depth,
that no `category_id` changed except the Travel transport payments, and that
the diagnosis invariants stay at zero; the frontend category picker shows the
new branch without code change because it reads the tree.

D1 and D3 are independent of each other and of everything else; D2 depends on
D1 only for the identity step's usefulness, not for its correctness, so D2 may
start at once and D1 may land before or after. Run D1 and D3 in parallel
worktrees; D2 in a third.

## A — attributes

**A1. Exceptional is a tag; `spending_pattern` goes.** Bounded, wide. Migration
30; `src/categories.ts` (tags gain optional `date_from`, `date_to`, `purpose`
columns now, unused until trips, and `setTags` writes a `tags_set` audit event),
`src/filters.ts` (`tag`, `excludeTag`; `pattern` removed), `src/reports.ts`
(`byTag`, `formatVersion: 2`, fingerprint includes tag ids), `src/repository.ts`
(attach tags to `Transaction` instead of `spendingPattern`), delete
`src/spending-pattern.ts` and its test, `frontend/src/Review.tsx` (tag chips
replace the pattern control), `frontend/src/Overview.tsx` (exceptional toggle
over the tag), `docs/spending-controls.md`. The migration creates the
`Exceptional` tag, inserts `transaction_tags` for every `spending_patterns` row
with `pattern='exceptional'`, writes one `tags_set` audit event per payment
carrying the old reason, and drops `spending_patterns`. Verify:
`test/categories.test.ts` (audit, household scope), `test/filters.test.ts`,
`test/reports.test.ts` (format 2, old snapshots untouched),
`test/migration-upgrade.test.ts`; the diagnosis SQL counts payments tagged
`Exceptional` before and after the rehearsal and they match the old
`exceptional` count.

**A2. Rules: household-scoped, condition-based, consolidated.** Hard. Migration
31; `src/categories.ts` (rule model, matcher, `saveRule`, `listRules` without
owner), a new `src/rule-conditions.ts` (pure matching of the ADR's condition
set against a payment, unit-tested), `src/transaction-triage.ts` (stage 3 uses
the new matcher), `src/web.ts` (rule endpoints household-scoped, plus the
consolidation proposals endpoint), `frontend/src/Categories.tsx` (rule editor
with conditions and an affected-payments preview; a bulk "apply all"
consolidation screen), a new `scripts/rule-consolidation.mjs` that computes the
proposals read-only for the rehearsal. The migration converts every rule to the
condition form (`descriptionEquals` / `counterpartyHash`), drops the owner
column into an `owner` condition, merges identical cross-owner pairs, keeps
disagreeing pairs as two owner-conditioned rules and reports the count, and
retires — `active=false`, reason recorded — every exact-description rule whose
only matching payment already carries that rule's decision. Merges into
merchant-key rules are *not* applied by the migration; they are proposals shown
once for bulk confirmation. Rule minting on confirmation
(`saveRuleFromDescription` callers in `src/web.ts`, `src/reply-workflow.ts`,
`src/payment-explanations.ts`) is removed and replaced by an explicit,
default-off "pin as rule" option. Verify: `test/rule-conditions.test.ts` for
every condition and the suffix-needs-company rule; `test/categories.test.ts`
for merge, retire and audit; a triage test that a retired rule's payment is
still decided identically by memory (depends on C2, so A2's triage assertion
lands with C2 if C2 is later); diagnosis SQL rule section re-run on the
rehearsal, expecting roughly 200 active rules and zero that match nothing.

A1 and A2 touch different code and run in parallel. A1 can start immediately;
A2 is better started after D2 so the triage selection change is in place.

## C — the pipeline

**C1. One evidence bundle, inspectable.** Hard. New `src/evidence.ts`
(`buildEvidence(tx, transactionId)` returning the ADR's stage-5 bundle plus the
deterministic signals: merchant key, counterparty identity, MCC, account,
receipt lines, explanations, past decisions by merchant key), used by
`src/classifier.ts` (request input), `src/receipt-categorization.ts` and
`src/payment-explanations.ts` and `src/reply-workflow.ts` (all lanes send the
same bundle), and stored with the proposal (`classifier_proposals.evidence
jsonb`) and with the triage decision, so `/api/transaction-details` can show
"what the classifier was given" (CAT-9). Redaction lives here and nowhere else:
account-identifier and card-number patterns, and no structured party-name
fields. Verify: `test/evidence.test.ts` asserts the redaction set with
synthetic payloads, asserts that a registered own account resolves to "one of
your own accounts" and not to any identifier, and asserts the input length stays
under `maxInputChars` for the largest synthetic case; `test/classifier.test.ts`
prompt-isolation cases keep passing.

**C2. Memory replaces `model_cache`.** Hard in semantics, small in code. New
`src/merchant-memory.ts` (pure decision over past decisions for a merchant key,
with the agreement, human-or-two-automatic, and processor-abstain rules from the
ADR), `src/transaction-triage.ts` (stage 4; `cachedDecision` removed),
`src/merchant-clustering.ts` (export the processor stop-list hook; the list
itself is configured, not the owner's merchants). Verify:
`test/merchant-memory.test.ts` — one human decision decides; one automatic does
not; two agreeing automatic do; any disagreement abstains with a recorded
reason; a correction to one payment flips the result on the next run; excluded
accounts contribute nothing; the measured 27 mixed shapes from
`test/merchant-clustering.test.ts` all abstain.

**C3. The model on the widened evidence.** Bounded once C1 exists.
`src/classifier.ts` consumes `buildEvidence`; instructions updated for the new
fields and for "a person, not a registered account"; request key `triage:v3`;
per-request settled cost recorded in the existing ledger with the request kind
so OPS-5 can read the per-payment figure from `/api/llm-budget`. Verify:
`test/classifier.test.ts` schema and stale-guard cases; a budget test that the
reservation for the widened input still fits the daily and monthly gates;
`docs/llm-budget.md` gains the measured figure after the first week.

**C4. Triage as the ordered pipeline.** Hard. `src/transaction-triage.ts`
rewritten around the seven stages, the 3,000 UAH line from `reviewPriority`,
provisional placement for new money, and the ask rule (memory backed by a human
decision does not ask above the line); policy string
`pipeline:v1`; `sufficientAutomaticConfidence` keeps its MCC-corroboration
cases. `src/clarification-cycle.ts` asks only for provisional new money above
the line or where the pipeline ended uncertain. Verify: `test/transaction-triage.test.ts`
rewritten as one table of synthetic payments × expected stage, source,
provisional flag and question; `test/clarification-cycle.test.ts` asserts no
question for booked_at before `liveFrom` regardless of amount; a replay test
over the private golden reference (`src/categorization-evaluation.ts`) reports
precision and coverage before and after, per the existing method.

**C5. One confirmation for every attribute.** Bounded after A1.
`src/web.ts` classify and explanation-confirm actions accept `tagIds` and write
kind, category and tags in one transaction with one audit event pair;
`src/reply-workflow.ts` Telegram confirm does the same; `frontend/src/Review.tsx`
confirms kind, category and tags from one form and shows the evidence bundle
under "What the classifier saw"; the "pin as rule" option from A2 appears here.
Verify: `test/spending-http.test.ts`, `test/reply-workflow.test.ts`,
`test/payment-explanations.test.ts` for atomicity and revision guards.

Order: C1 → C3 → C4 is sequential. C2 is independent of C1 and may run in
parallel with it. C5 waits for A1 and A2's "pin as rule" hook but not for C4.

## B — analytics

**B1. The grammar and the aggregation endpoint.** Bounded, with one invariant
that must be tested exhaustively. `src/filters.ts` (the grammar in
[analytics](analytics.md), node ids, `account`, `kinds`, `tag`, `excludeTag`,
`provisional`; legacy path strings resolved for one release), `src/repository.ts`
(`list` accepts account filter), a new `src/aggregate.ts` (grouping over
`convertedSpending` rows: buckets, series, tree roll-up, coverage), `src/web.ts`
(`/api/analytics`). Verify: `test/aggregate.test.ts` generates synthetic ledgers
and asserts, for every bucket and series key, that `/api/transactions` with the
same grammar sums to the same figure; branch equals the sum of its leaves;
`excludeTag` and `kinds` apply to totals and buckets alike; refund-net counted;
missing FX reported not zeroed. `test/filters.test.ts` for the grammar.

**B2. The Analytics screen.** Bounded. `frontend/src/Analytics.tsx` becomes its
own screen per the design; `frontend/src/lib/` gains the query hooks;
`frontend/src/Overview.tsx` gains only the coverage strip and the provisional
count. Verify: `test/frontend-api.test.ts` contract cases for the endpoint
shape; `test/navigation-state.test.ts` for URL round-trips of the new filters;
a manual pass at phone width listed in the PR.

**B3. Transactions accepts the full grammar.** Bounded. `frontend/src/Review.tsx`
and `/api/review` read the same filter set so every drill link lands on exactly
the rows that produced the figure. Verify: a synthetic test that follows a
drill link from B1's response and compares the row set.

B1 depends on D2 (the `provisional` column) and benefits from A1 (the tag) but
needs neither to start: `tag` filters work on the tags that already exist. B2
and B3 depend on B1 and run in parallel with each other.

## The critical path, and what ships when

1. **D1, D2, D3 in parallel** — one release. The owner sees a complete 2026,
   with the catch-all visible and the tree in their shape. This is the whole of
   Topic D and most of the felt problem.
2. **A1 and B1 in parallel**, then **B2 and B3 in parallel** — one or two
   releases. Exceptional is a tag; the analytics screen answers the owner's
   questions with drill-down; coverage is visible.
3. **C1 and C2 in parallel**, then **C3**, then **C4** — the pipeline. Fewer
   model calls, memory, questions about new money only, inspectable evidence.
4. **A2**, then **C5** — rules consolidated and household-scoped; one
   confirmation for everything; the rule editor.

OPS-5 is read after C3 has run for a week. CAT-6 (trips) is not scheduled; A1
leaves the two optional tag columns it needs. REC-2/REC-3 stay deferred; nothing
above writes anything per receipt line.

## What each step must not do

No step sends a real payment description, merchant name or amount into Git,
tests or general logs; synthetic data only. No step lowers the model bar to make
a number look better. No step asks the owner about a payment booked before the
live boundary. No step overwrites a payment that carries a `classified` event.
No step raises the AI cap. A step that finds itself editing a fourth module or
changing what a total means beyond what the ADR states stops and says so —
that is the escalation trigger, and it is cheaper to hit early.
