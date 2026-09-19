# Project to-do list

Reviewed September 14, 2026 against the owner conversation, roadmap, requirements,
workflow documents and latest verified release. This is the canonical open-work
list; roadmap summarizes delivered capabilities, STATUS records release evidence.
Unchecked means unfinished, not automatically blocked. Order below is a proposed
implementation order, not a new permission gate. Ship small, separately verified
increments with fresh commits and documentation.

## 1. Backend refactoring and measured performance — next

Initial [architecture assessment and API baseline](backend-assessment.md) are saved.
Fastify is recommended, not yet selected. BE-1 remains open: browser waterfall,
query/CPU attribution and sufficient percentile sampling are still needed.

- [ ] **PF-012 / BE-1: establish a baseline.** Measure representative list/detail,
      Overview/Analytics, FX and receipt requests: duration, query count and response
      size; use synthetic data locally and private aggregate measurements on the server.
      Record before/after results, without financial descriptions in logs.
- [ ] **PF-012 / BE-2: refactor backend boundaries.** Review HTTP routing/validation,
      authorization, application services and data access; extract cohesive modules
      where responsibilities are mixed (including `src/web.ts`). Document the concrete
      design before changing it. This is a separate maintainability task, not merely
      frontend caching or SQL batching; no replacement backend stack is selected.
      Preserve API contracts, owner permissions, exact arithmetic, audit history,
      idempotency, transaction/lock ordering and human overrides. Verify equivalence
      and failure paths after each extraction, not a whole-backend rewrite.
- [ ] **PF-010/012 / BE-3: optimize measured bottlenecks.** Aggregation and
      further batching only where the baseline justifies them; verify identical
      counts/totals and query plans. Review worker retry/error boundaries alongside
      the affected service, without combining unrelated financial changes. Delivered
      on September 17, 2026: `/api/transactions` selects, filters and cuts a page in
      SQL with the indexes of migration 45; see [performance](performance.md).

Already delivered: review suggestion/tag batching (synthetic query count 28 → 3),
separate payment detail requests and fingerprinted private asset caching. These do
not establish overall production latency or complete backend refactoring.

## 1b. Household assets — steps one, two and four done, the Telegram round open

See [assets](assets.md) for the model and the plan.

- [x] **PF-020 / AS-1: holdings, snapshots, prices, screen, history import.**
      Migration 51; `/assets`; `scripts/holdings_from_spreadsheet.py` and
      `holdings-import-cli`. Deployed September 17, 2026 as 1ef7b68; the owner's
      history is loaded.
- [x] **PF-020 / AS-2: automatic balances.** Balances themselves landed with the
      Balances page (migration 53); a holding links to an account and the
      last-Thursday 10:05 Riga job fills it (migration 54). Deployed September
      18, 2026; timer installed and enabled, 13 bank holdings linked and filled.
- [ ] **PF-020 / AS-3: the monthly round in Telegram.** Missing-figure list to
      the household chat, parsed replies, a nudge after two days, maturity notices,
      and movement proposals between holdings confirmed with one tap.
- [x] **PF-020 / AS-4: feeds.** IBKR Flex Web Service, Binance Spot read-only,
      BTC and ETH wallets by address with the exchange's open prices. Deployed
      September 18, 2026; both credentials verified, positions, exchange total
      and wallets filled, the broker's cash from the base-currency summary
      (b22a37a), the exchange per coin and the wallet by extended key
      (9d5d882). Only LHV awaits its first stated balance.
- [ ] **PF-020 / AS-6: movements between holdings.** When a snapshot is made,
      pair equal-and-opposite changes between two holdings (money that left one
      and arrived in another) and let the owner confirm them as a transfer, so a
      move is never read as a loss and a gain; show the unexplained remainder per
      holding. Wanted, later (owner, September 18, 2026).
- [ ] **Bond maturity notices.** A bond or deposit reaching its maturity date
      is announced — a due list on Assets, and a Telegram line once the round
      exists — with a nudge to buy the next one. Wanted, later (owner,
      September 18, 2026); until then the owner retires the old holding and
      creates the new one by hand.
- [ ] **Monthly income estimate.** A trailing average of salary and dividend
      inflows from the transactions system, shown as a separate figure. Wanted,
      later (owner, September 18, 2026).
- [ ] **PF-020 / AS-5: the company sheet feed.** A holding fed from a small
      Google Sheet the company file copies a few labelled cells into on a timer,
      read through the Sheets API as a service account the sheet is shared with;
      first use: the FOP's personal USD share. Parked by the owner on
      September 18, 2026; the FOP USD share is typed by hand for now.

## 2. Finish smooth frontend behavior

- [ ] **PF-010 / FE-1: migrate remaining screens to shared Query caching.** Audit
      Overview, Analytics, FX, Reports, Accounts, Categories, Connections, Settings and
      operations views; record actual gaps, then migrate one screen at a time. Keep
      loaded content during refresh and invalidate affected data after edits.
- [ ] **PF-010 / FE-2: verify navigation/state across the whole app.** Currency,
      owner, period, filters, sorting, pagination and selected records should survive
      URLs and Back/Forward wherever applicable. No routine page reload; no live polling
      requested. Preserve owner-isolated in-memory caches and truthful currency labels.
- [ ] **PF-010 / FE-3: usability/accessibility pass on changed screens.** Phone and
      desktop, light/dark, consistent shadcn spacing, long labels, keyboard/focus,
      loading/empty/error states and scroll restoration. Measure responsiveness rather
      than assuming a library migration makes everything fast.

Delivered: the [transaction review page](transaction-review-page.md) was rewritten
around what identifies a payment — labelled facts, an account chip, searchable
category and tag pickers, one combined decision, a single refund block and a
readable bank record over the collapsed complete field list. A suggestion now
proposes tags from the household's own list alongside type and category, and
[answering in Telegram](telegram-replies.md) saves the decision instead of asking
for a second confirmation, acknowledging the message and replying with what was
saved and a link back to it.

Keep React/Vite, shadcn/ui, Tailwind, Recharts, Lucide, TanStack Router and Query.
Transactions and Receipts already use shared caching; full-page explanation-first
review and cash entry are delivered. No new framework, Tremor or advanced table
library is implied.

## 3. More reliable categorization and editable rules

[ADR 0006](adr/0006-classifying-what-money-was-for.md) built the structure
(schema 25/26): one shared tree, a payment points at a leaf, parents are not
assignable, account purpose is recorded on the payment.
[ADR 0008](adr/0008-attributes-and-the-classification-pipeline.md) decides the
rest — the attribute model, the tree reconciled with the owner's list, one
ordered pipeline, merchant memory instead of minted rules, household-scoped
rules, and a provisional resting place for the backlog — and records every
owner decision and the September 14 production figures it argues from, so they
are not repeated here. [The work plan](classification-work-plan.md) orders the
build and names files, tests and parallelism; its step ids (D1–D3, A1–A2,
C1–C5, B1–B3) replace the older item texts below. [Refunds](refunds.md) is built
and deployed; read it before touching incoming money or spending totals.

- [x] **PF-004/005 / CAT-D: the 2026 backlog placed, not queued** — done and
      deployed across schema 28, 29, 30 and 31. Own-account identifiers are
      registered, `provisional` and `classification_source` exist and are read
      everywhere, the sweep places undecided outflows, and the tree is reconciled.
      The Ride-hailing rename named below was withdrawn: the owner said "no need
      renaming", and their use cases rather than their labels are what matter. The
      original wording is kept for the record — plan D1–D3,
      first and small. Register own-account identifiers from provider metadata; add
      `provisional` and `classification_source`; sweep personal-account outflows
      into identity decisions or a provisional resting category (MCC leaf, else a
      stored ≥ 0.7 model leaf, else root `Unspecified`) counted as personal
      spending; reconcile the tree (Utilities branch with phone and internet,
      flights to Long distance, Ride-hailing renamed Taxi).
- [ ] **PF-005 / CAT-8: one pipeline over all the evidence** — plan C1–C4. One
      evidence bundle for every lane, stored for inspection; merchant memory
      replaces `model_cache`; the model on the widened evidence; triage as the
      ordered stages with the 3,000 UAH line and provisional placement for new
      money; questions about new money only. Absorbs CAT-2 (operation-aware
      resolver) and CAT-11 (merchant identity, measured at 95.4% cluster purity in
      `src/merchant-clustering.ts`; a strong signal, never an authority).
- [ ] **PF-005/007 / CAT-1: rules household-scoped, condition-based, few** —
      plan A2. Merge the 110 cross-owner duplicates, retire single-payment exact
      rules that memory covers, propose merchant-key merges for bulk confirmation,
      stop minting rules on confirmation, rule editor with affected-payment preview.
      The AI never creates a rule (ADR 0008).
- [ ] **PF-005/008 / CAT-9 + CAT-10: inspectable and editable from Review** —
      plan C1 ("what the classifier saw") and C5 (one confirmation for kind,
      category and tags; explicit default-off "pin as rule"). Extends
      `projectTransactionDetails` and [payment explanations](payment-explanations.md)
      rather than rebuilding them.
- [ ] **PF-004/008 / CAT-7: tags gain an audit event and trip columns** — plan A1,
      minus the part that is now decided otherwise. On September 15, 2026 the owner
      reconsidered Exceptional and kept it a field on the payment rather than a tag,
      because its purpose is to be filtered on and a tag would mix it with tags that
      describe what a payment was about; the review form and an Exceptional filter in
      the transaction list are built on that. So `spending_pattern` stays. What
      remains here is the tag work itself: an audit event, and the two optional
      columns trips will use; reports move to `byTag` under format version 2.
- [ ] **PF-005 / CAT-6: trips** — a tag with a date range and a business-or-rest
      purpose (ADR 0008), assigned deliberately, never derived from dates; not
      scheduled. "How much on alcohol" is REC-2/REC-3, not a tag.
- [x] **PF-005/006/011 / REC-1 (partial): receipt matching quality.** Token-based
      merchant comparison ignoring legal form and geography, a three-day Enable Banking
      booking window, duplicate detection by image digest and by extracted purchase,
      and a guard against a second automatic link. Extraction-quality review stays open.
- [x] **PF-003 / CAT-3: family-transfer evidence.** Built and deployed at schema
      30 (`src/counterparty-identity.ts`). A transfer is household money when a
      provider states a counterparty identifier, when it names a card the owner has
      identified, or when the owner has said so about the counterparty — taken from
      the rules they already wrote and from every transfer they categorise by hand,
      matched on a spelling-insensitive key so one entry covers `Kate Baeva`,
      `Катерина Б.` and `КАТЕРИНА Б`.

  **Both-sides corroboration is rejected, not outstanding.** It was built,
  measured and removed at the owner's instruction: this system does not hold
  every account of the household, so the other half of a real transfer is often
  absent, while a pair that does appear may be two unrelated payments of the
  same size — which takes real spending out of the totals. A test asserts that
  two same-amount payments teach nothing. Do not rebuild it.

  Card suffixes were also measured rather than assumed: 38 payments in 4,064
  name a card, across 28 distinct cards of which 22 appear exactly once, because
  the printed number is the _other_ party's card. The path is kept and is right
  when it fires, but it is not a route to bulk identification.

- [ ] **CAT-12: clear the recurring transfer counterparties.** The one piece of
      this with real numbers behind it. On production 123 payments are still counted
      as spending on only **28 distinct counterparties**; because a manual decision
      is now remembered, categorising one transfer per counterparty resolves all 123
      and every future payment to them. Needs a place to do that — a list grouped by
      counterparty rather than by payment, in the app rather than over Telegram,
      because history must never become a question (ADR 0008). The recognition
      section of `scripts/category-diagnosis.sql` reports the current figure.

- [x] **CAT-13: nothing about a counterparty is hidden any more.** Closed by
      removing the mechanism rather than building a screen for it. A short-lived
      `counterparty_memory` table held what the owner had said about a counterparty;
      they asked why it existed when rules already say "payments matching this text
      are of this kind", and measurement agreed — nine entries across nine distinct
      spellings, so the spelling-insensitive matching that justified a separate
      store was doing no work at all. Schema 32 moves every entry into
      `classification_rules` and drops the table. Categorising a transfer by hand
      now writes a rule, deciding it was spending after all retires that rule, and
      both are visible wherever rules are. Normalised comparison survives as part of
      matching, so a spelling variant still resolves without a second copy of the
      text being stored anywhere.

- [ ] **PF-005/007/011 / CAT-4: evaluate before broad application.** Plan C4
      replays the private golden reference through `src/categorization-evaluation.ts`
      before and after; wrong approvals, precision and coverage reported separately.
- [ ] **PF-001/004 / CAT-5: new-account defaults.** Apply the agreed Wise/Revolut,
      Monobank white/other and FOP policies when new accounts are discovered, with
      auditable exceptions. Current accounts are already configured.

## 4. Finish 2026 history and trustworthy spending analysis

- [ ] **PF-004/010 / HIST-5: rebuild Analytics around the owner's questions.**
      Designed in [analytics](analytics.md): each use case mapped to the filter
      grammar and the `/api/analytics` aggregation it needs, with drill-down totals
      that must equal the figure by test. Build is plan B1–B3.

- [ ] **PF-003/005/010 / HIST-1: reconcile with the manually reviewed workbook.**
      Explain monthly differences by account coverage, exclusions, transfers,
      investments, reversals, FX and estimates. The workbook is comparison evidence,
      not new bank rows or unquestioned truth. Refresh queue counts before work; old
      counts such as 204 unclear/85 estimates are historical snapshots, not live status.
- [ ] **PF-005 / HIST-2: recent manual review and older estimates.** Use
      evidence-backed estimates for older payments and show their uncertainty
      separately; the 3,000 UAH priority line was retired on September 17, 2026.
      Keep 2025 archived, not deleted.
- [ ] **PF-005 / HIST-3: one-time payment-context investigation — awaiting exports.**
      Use owner-provided email, Telegram, WhatsApp, Viber and SMS exports where available;
      search available card/reference/name/date/amount evidence, retain source pointers
      and ask only on remaining ambiguity. This is offline 2026 research, not an app
      communication-search feature. Verify treasury-payment purpose and known family
      support/insurance exceptions rather than generalizing all same-name payments.

Home and Analytics, selected periods/global currency and historical estimate
separation are already delivered. Further changes should solve
an identified gap, not restart the dashboard redesign.

## 5. Receipt quality and item-level reporting

- [ ] **PF-005/006/011 / REC-1: validate real extraction/matching quality.** Check
      merchant-name differences, generic lines and delayed imports; observe failed or
      ambiguous cases. A receipt cannot reveal coffee/dessert when it only says drinks.
- [ ] **REC-2: priced item extraction and corrections.** Versioned quantity/unit
      price/discount/deposit/tax/line totals, exact reconciliation to receipt/payment,
      confidence and an editable correction workflow with a quality evaluation set.
- [ ] **REC-3: optional item allocations and reports.** Split a purchase into
      categories/items without duplicate spending; show unallocated coverage. Agree
      deposit and mixed personal/business basket treatment before implementation.

  A route that looked promising and is **closed**, recorded so it is not
  investigated again. Monobank sends a `receiptId` on 3,212 of 4,022 payments,
  including 2,787 ordinary purchases, and the ledger already stores it — but the
  personal API cannot turn one into anything. Its complete surface is five
  endpoints (currency rates, bank public key, client info, set webhook,
  statement) and none accepts a receipt identifier or returns line items. The
  receipt/fiscal-check endpoints that do exist belong to the _acquiring_ API:
  they need a merchant token, are keyed by `invoiceId`, and only cover invoices
  issued as a seller. The only remaining path is scraping check.gov.ua or
  check.monobank.ua, which are human-facing pages. So item data keeps coming
  from photographed receipts.

- [x] **REC-4: PDF/multi-page ingestion and evidence retention/deletion controls.**
      Preserve privacy and explain backup implications. Reuse extraction and bound
      retries within the shared AI budget. Direct in-app upload is a possible convenience
      extension; the requested Telegram photo channel already works. PDF receipts are
      accepted and rendered to page images with poppler behind a replaceable interface,
      capped at eight pages, refused before any spend when unreadable or too long.
      Owner deletion of
      a receipt (soft delete: photo and extraction removed, cost ledger and audit
      history preserved, linked payment detached) is implemented and tested on
      `feat/receipt-deletion`, not yet deployed; PDF ingestion and retention policy
      remain open.

Receipt photos, shared family matching, delayed matching and receipt-informed
transaction categorization are delivered. Telegram feedback on the photo message
(👍 linked, 👀 waiting for the bank, plain reply on non-receipt/failure; durable
and bounded) is implemented and tested on `feat/receipt-telegram-feedback`, not
yet deployed. REC-2/3 remain intentionally deferred
architecture, per the owner's instruction. See [item plan](receipt-item-analytics.md).

## 6. Financial edge cases and settings

- [x] **PF-004 / FIN-1 (partial): refunds.** A refund reduces a purchase instead of
      rewriting it, partial reductions accumulate, matching compares original amounts
      within one account, and unclear reversals become Telegram questions rather than
      guesses. Deployed and running: 136 of the 138 merchant reversals in the ledger
      are linked, and the two left are a purchase on an account we do not sync and a
      charge that was never imported. See [refunds](refunds.md). Fees and
      mixed/split payments remain open below.
- [ ] **FIN-1c: unexplained incoming money from people.** 125 incoming payments
      totalling about 35,800 UAH, from September 2025 to September 2026, are money a
      person sent that nothing explains. The matcher deliberately never guesses at
      these and never asks about history, so they need a place in the app — grouped
      by sender, the same shape CAT-12 needs for outgoing transfers, and best built
      once for both directions.
- [ ] **PF-004 / FIN-1b: fees and mixed/split payments.** Define policies, preserve
      exact reconciliation and avoid hiding uncertain reversals.
- [ ] **PF-004 / FIN-2: cash withdrawal versus cash purchase reconciliation.**
      Prevent double counting; simple cash purchase entry already exists.
- [ ] **PF-009 / FIN-3: actionable missing-FX coverage.** Show affected dates,
      currencies and transactions plus recovery status; retain approved commercial
      midpoint fallback and actual-bank precedence. Continue daily ingestion checks.
- [ ] **PF-010 / SET-1: finish the settings/navigation audit.** Verify convenient
      links to bank connections (Kate retains her own consent access), account purposes,
      Telegram/receipt health, budget and expiry. Default currency/period and a separate
      hide-investments preference need a concrete UX/default proposal before adding knobs.

Admin-only business/family-transfer/full-refund visibility defaults are delivered.
Keep Investment as an explicit movement kind/badge/filter: the proposed taxonomy
change was cancelled; do not silently turn it into a generic tag or income feature.

## 7. Operations and release reliability

- [x] **PF-012 / OPS-1: encrypted AWS S3 backups — done 19 September 2026.** The
      bucket, its lifecycle rule and a bucket-scoped IAM user exist; restic encrypts
      before upload, the daily timer is enabled, the `backup_runs` table records every
      attempt and System health reads the age of the last copy. The restore was proved,
      not assumed: `restic check --read-data` clean, a snapshot restored into a separate
      disposable database, all 50 tables and the per-currency totals compared, the only
      differences being rows created after the dump was taken.
      `/etc/private-finances/off-server-restore-verified` records it. See
      [the backup runbook](backups.md).
- [ ] **PF-012 / OPS-4: pre-deployment dumps accumulate without a limit.** On
      19 September 2026 `/var/lib/private-finances/predeploy/` held 134 dumps and
      442 MB, and the root filesystem was 90% full with 10 GB free on a disk shared
      with other applications. `deploy/release.sh` writes one before every switch and
      nothing removes any. They are the rollback safety net for a release, so the
      answer is a retention rule rather than deletion — the newest few, or the last
      few days. Decide the rule before the disk decides it.
- [ ] **PF-012 / OPS-3: backup retention.** `restic forget --prune` is still
      unscheduled, because pruning deletes and nothing should delete a backup casually.
      The proposal remains 14 daily, 8 weekly and 12 monthly snapshots. At roughly 5 MB
      a day, deduplicated, there is no pressure to decide quickly. Whatever is chosen,
      the 30-day noncurrent-version rule on the bucket stays as the floor beneath it.
- [ ] **PF-012 / OPS-2: automate more of release delivery.** Build on existing CI
      and guarded deployment: reproducible artifacts, migration/backup gates, wait for
      active imports, health checks and a demonstrated failure rollback. Preserve other
      applications on the shared server; do not describe current deployment as absent.
      The intended shape is already in [the deployment contract](operations.md): a
      `workflow_dispatch` run for one explicitly chosen verified commit, with the runner
      reaching the server over a Tailscale ephemeral identity rather than an agent's own
      SSH session. Four things learned on September 13 and 14 belong in the design.
      First, the motivation is not only convenience: the agent's permission layer refuses
      to stage or switch a release regardless of the owner's approval, so a release
      currently needs the owner to change permission mode, while a workflow run is an
      ordinary API call that does not. Second, the owner has asked not to be handed a
      list of manual commands as the answer to a deployment problem. Third, the
      prerequisite is the owner's: repository secrets for the Tailscale identity and a
      deploy key cannot be written by the token in `~/.local/bin/pf-gh`, which receives
      403 on the secrets API. Fourth, `deploy/switch-release.py` restarts only the
      dashboard, so any automation must stop `private-finances-telegram.service` before
      the switch and start it afterwards, or the worker keeps serving the previous
      release; a release attempt that missed this left the worker down. The release
      sequence proven by hand is: stage a tracked-source archive into a new release
      directory, install and build there, run the suite on the server, restore a copy of
      production into a disposable database and migrate it to prove the migration
      applies to an already-migrated schema, then stop the worker, switch, start the
      worker and verify the release SHA, schema version and worker stability. See
      [what the production server needs](server-requirements.md).
- [ ] **PF-011 / OPS-5: re-check the AI budget once classification widens.** The
      owner kept the $10 monthly cap "so far" and asked to be reminded to revisit it
      rather than deciding in advance, so this is the reminder. September 2026 spent
      2,695 model requests clearing the backlog on the narrow evidence slice; CAT-8
      sends more per payment, so the figure to bring back is the measured cost per
      payment under the widened evidence, and what a normal month costs at that rate
      once the backlog is gone. Raise it only with the owner's decision; the cap is
      never lifted mid-task to finish something.
- [ ] **PF-012 / OPS-4: tighten server access to least privilege.** Two recorded
      deviations: the `radar` user has unrestricted passwordless sudo, contradicting the
      deployment contract, and `sshd_config` sets `PermitRootLogin yes`. Together the
      `radar` key is effectively root. Agree a sudo rule covering only `switch-release.py`,
      the sync timers and the Telegram unit; disable direct root SSH login. Verify each
      service still runs afterwards, keep a working session open while applying it, and
      coordinate with the other agent so nobody is locked out mid-task. Recorded in
      [operations](operations.md) and STATUS.
- [ ] **PF-012 / OPS-3: actionable operational alerts.** Audit current coverage and
      add missing stale-import, consent/auth failure, receipt/Telegram processing,
      backup/restore and release failure alerts, with deduplication and recovery notices.
      Preserve existing credential-expiry and $10 budget protections. The one-time half-hour polling/Telegram check completed September 12: all three
      connections succeeded and no duplicate payment/revision questions were found.
      Broader operational alert implementation remains open.

## Closed / not active blockers

- Kate Wise connected and imported; owner confirms low activity is expected, six
  screenshot entries spot-checked. Reopen only for a specific missing payment.
- Telegram reply history and app explanations are saved and visible; full-page
  review and simple cash purchases are live. Observe errors without relisting these
  features as unimplemented.
- FX calendar-date fix and approved commercial historical rate ingestion delivered;
  missing coverage must still stay visible as new dates arrive.
- Monobank jars excluded by choice. Income analytics, live dashboard updates and
  2025 deletion are outside current scope.

For each task: link its ID in the PR, record the verified result and deployment
status, then check it off here. Do not mark an entire section done after one subtask.
