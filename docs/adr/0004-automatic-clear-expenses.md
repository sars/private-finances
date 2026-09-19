# Automatic clear personal expenses

PF-005/PF-007: the owner authorized applying clear expense classifications.
`AUTO_CATEGORIZE_CLEAR_EXPENSES=true` enables this in the Telegram runtime;
it is off by default. The shared monthly AI budget is unchanged.

Only booked outflows with a current category and personal-expense confidence of
at least 0.95 are eligible. Confidence from 0.90 up to (but below) 0.95 is also eligible when
its bank MCC is on the bounded consumer list below and transaction signals contain
no transfer, competing financial purpose, exceptional or nonpersonal context. Model proposals, explicit phone signals and current,
unambiguous owner-confirmed exact rules are supported. Business/investment
accounts and all other movement kinds remain for review. Historical evidence is
local and cannot trigger automatic application. Existing ready suggestions can
be applied without paying for another request.

A transaction lock and revision check prevent application after a source change
or owner decision. Category edits share a lock with application. The update,
triage completion and `auto_classified` audit event commit together. The automatic
actor is `transaction_triage`; the event includes input and output revisions,
policy version and proposal/rule provenance. Human `classified` events keep their
existing meaning and priority. The existing manual classification action reverses
an automatic decision and prevents further automatic intervention.

Sport / Racket sports is part of new starter catalogs. Recognizable existing
starter catalogs receive only these missing nodes; custom nodes and placement
are preserved. The model uses its merchant/service knowledge together with payment context;
there is no Playtomic-specific rule or answer embedded in its prompt. It must
not invent a padel-versus-tennis distinction without supporting evidence.

## Bounded local reuse

To reduce repeated paid requests during historical triage, automatic model
decisions record an exact owner/source/account/description/MCC/account-purpose
signature. A later outflow may reuse an original model decision at confidence
0.90 or above with supported consumer evidence only while its audit revision remains current and its category
still exists. Consumer MCCs are limited to 4814, 5411, 5812, 5814, 5942, 7997,
5541 and 4121. Transfer and exceptional/nonpersonal descriptions cannot reuse
this cache. Conflicting owner corrections prevent reuse; cached decisions cannot
become cache donors. More than 20 original candidates disables reuse for that
signature. The source is `model_cache` with the originating audit and proposal IDs.
Final application rechecks the donor under a shared transaction lock. Old audit
records without a saved signature are deliberately ineligible.

Generic `Other` leaf categories never auto-apply or seed cache reuse. New model
triage uses request key `triage:v2` for the sport-aware prompt. Prior v1 proposals
and their provenance remain intact; any targeted retriage is an explicit rollout
operation rather than a bulk reset in the worker.

## Historical rollout and corrections

The operator can run `node dist/src/categorize-cli.js` with the same private
environment as the Telegram worker and `AUTO_CATEGORIZE_CLEAR_EXPENSES=true`.
`CATEGORIZE_MAX_TRANSACTIONS` bounds a pass (default 10,000, maximum 20,000).
It shares atomic monthly reservations with every other AI consumer. Progress logs
contain counts only. The per-day request ceiling may be raised for the initial
backfill without changing the $10 monthly maximum or $0.50 safety buffer.

Current owner rules and local historical evidence take precedence over stored
model suggestions. Final application rechecks rules and account purpose under
shared locks. Bank corrections reset AI-only classifications to unresolved and
record `auto_classification_invalidated`; human decisions remain intact.

Do not enable automatic application while old importer releases that lack this
invalidation are running. Existing generic Other suggestions are not automatically
applied. A targeted, audited retriage may be needed after adding a missing category.

## Evidence policy version 2

The worker applies one generic confidence policy across merchants; no named
merchant receives a special category or threshold. Saved ready proposals at
confidence 0.90 or above can be evaluated against the current consumer evidence
without another model request. An evaluated ready decision records
`automaticReviewPolicy=clear_personal_expense:v2`, so a policy rejection stays
reviewable and cannot loop through the automatic queue. Existing human, rule,
historical, account-purpose, category and revision checks remain in force.
Automatic audit events identify policy version 2. Model-cache reuse requires the
same supported consumer evidence and retains its exact-signature restrictions.

Known transfer, exceptional, competing financial-purpose and nonpersonal signals
block automatic model/model-cache decisions at every confidence, including 0.99.
The consumer MCC list supplies additional evidence, never permission to ignore
contradictions. Explicit current owner-confirmed rules retain their precedence;
phone-signal decisions retain their existing purpose checks.

## September 12 correction: confirmed rules and restaurant corroboration (v3)

Explicit, unambiguous owner-confirmed exact rules now also apply investment,
internal-transfer and non-personal classifications. They can label booked inflows
when the confirmed rule is one of those non-expense kinds. Model-only investment
suggestions still require review. Rules are revalidated under the category lock;
new/changed rules revisit stored suggestions without repeating paid requests.

A restaurant proposal of at least0.70 is sufficient only when its category is
`Food / Restaurants`, the bank MCC is5812 or5814, there are no contradictory
transaction signals and the account is not excluded. Both sources agree on the
broad category; MCC alone and unrelated category/MCC combinations are insufficient.
Existing proposals are evaluated locally under v3. Other model thresholds remain
unchanged. Human decisions and refund/account exclusions retain priority.

Amount and currency are now supplied as contextual clues, never as proof of an
item or as inputs to model-calculated totals. A low venue payment can suggest
uncertainty about a precise activity; it cannot establish that a drink was bought.
