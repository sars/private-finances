# Account defaults, settings, resolver and navigation proposal

September 12, 2026. Account-purpose update is applied and verified. The owner has selected TanStack Router + Query and authorized the atomic sequence.
Items below remain planned until individually recorded as verified in STATUS.
Work must stay in small, independently tested commits/releases; do not combine a
routing migration with classification or financial calculation changes.

## Applied account policy

All currently connected Wise/Revolut accounts: personal by default. Monobank white
cards: business by default. Other personal Monobank cards: personal by default.
FOP accounts: business only. Fifteen accounts changed from unreviewed to personal;
six business accounts were already correct. Normal Accounts.upsert preserved
identifiers, incremented revisions and recorded reasons in private audit history.
No bank records or transaction classifications were rewritten. This updates current
accounts; automatic policy assignment for newly discovered accounts is not yet added.

Account purpose is distinct from transaction purpose. A personal account can fund
an investment; a white-card bond purchase can be an explicit investment exception.
Keep financial movement kind authoritative (personal spending / family transfer /
investment / business), category for purchase purpose, and routine/exceptional
pattern independently. Present Investment as a clear badge and filter, rather
than relying only on a freely editable tag to exclude amounts from personal totals.
Family transfers must be confirmed, not inferred solely from a similar name.

## Settings deployed and verified

Rodion is the initial admin. Enforce permissions at the API, not just navigation.
Admin settings manage household browsing defaults:

- Hide business transactions: on.
- Hide confirmed family/own-account transfers: on.
- Hide credits linked to a purchase as a refund: on; the purchase itself always
  stays visible, and a link that disagrees with a later correction brings its
  credit back ([refunds](refunds.md)).
- Hide investments: proposed separate option; do not silently change current
  browsing behavior before agreeing its default.

These are visibility defaults, not destructive filters or report-classification
rules. Individual transaction views may temporarily override them through URL
filters; show active exclusions, matching counts and a Show all action. Direct
links still open authorized hidden records. An explicit investment exception on a
white card should follow Investment visibility, not disappear as ordinary business.
Unknown transfers stay visible. Household defaults apply to both owners; only
Rodion edits them. This household scope is implemented and permission-tested.

Useful additional sections: default display currency/reporting period, account
purposes, bank connection links, receipt/Telegram status, existing AI budget and key
expiry status. Avoid unrelated new knobs. Bank consent remains owner-specific:
Kate must retain a way to renew her own consent even if the admin settings page is
Rodion-only. Moving a navigation link cannot grant Rodion permission to consent as Kate.

## Resolver proposal

Current confirmed rules match exact description/counterparty text. This is useful
for narrow explicit exceptions but insufficient for general merchant recognition.
Do not broaden all existing rules into substring matches or silently delete them.

Use a common, versioned evidence record: owner, account/provider/purpose, debit or
credit, currencies, amount, date, transaction type, MCC and label, counterparty
name plus available stable identifiers, merchant location/country, original bank
operation, receipt evidence, owner explanations and matched transfer/refund links.
Keep raw private evidence server-side; send only relevant redacted features to AI.

Resolution order:

1. Preserve human decisions and confirmed refund/transfer links.
2. Apply account defaults and explicit transaction exceptions.
3. Evaluate scoped rules with required conditions and exclusions; detect conflicts.
4. Use merchant/MCC/receipt/operation evidence and bounded AI for unresolved cases.
5. Auto-apply only at evidence-appropriate confidence; otherwise ask a useful question.

Jar replenishment is an operation pattern, not the same as purchasing from the name
inside the jar title. For personal outgoing Monobank jar contributions, the owner's
stated default is charity/donation. First exclude a known own/family jar movement,
business/investment evidence, reversal or conflicting human explanation. A title
mentioning a food-delivery brand must not override clear donation-operation context.
Do not treat every generic top-up, incoming transfer or MCC 4829 transaction as a
charitable gift. Amount may strengthen or weaken a hypothesis; never identify a
purpose solely from its size. Small club purchases can be food/drinks if evidence
supports it, but price alone does not prove the item purchased.

Merchant identities should be scoped by stable ID when available, then country,
location/provider and corroborating metadata. Same-name merchants may differ.
Missing identifiers mean uncertainty, not an invented match. Rule UI should expose
conditions, exclusions, explanation, version, a preview of affected rows and a
small counterexample set before activation. An AI proposal cannot silently become
a permanent household rule. Migrate existing rules through review; retain audit.

Evaluate against frozen synthetic/anonymized fixtures and private owner-confirmed
examples: donation jars vs wallet top-ups, investment funding vs shopping, same-name
merchants, family transfers, receipt corrections, and white-card exceptions. Report
precision and review coverage separately; reducing the unresolved count alone is
not success. Compare in shadow mode before applying revised resolver decisions.

## Selected frontend stack and alternatives

Keep React + Vite + shadcn/ui + Tailwind + Recharts + Lucide.

| Option                                         | Benefit                                                                                                       | Cost / limitation                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TanStack Router + TanStack Query (recommended) | Typed/validated URL state; shared data caching and targeted invalidation; good fit for many financial filters | Two new focused dependencies; route/query conventions and incremental migration needed                            |
| React Router Data mode + TanStack Query        | Smooth client navigation and established routing APIs; similarly capable                                      | More application conventions for typed/validated search state; avoid duplicate loader and query caches            |
| Next.js                                        | Server/client rendering and integrated routing/navigation                                                     | Larger server/framework migration with little immediate benefit for this private dashboard; does not fix slow SQL |

Sources: [TanStack URL state](https://tanstack.com/router/latest/docs/guide/search-params),
[Query defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults),
[React Router modes](https://reactrouter.com/start/modes),
[React Router search parameters](https://reactrouter.com/api/hooks/useSearchParams),
[Next navigation](https://nextjs.org/docs/app/getting-started/linking-and-navigating),
[Next rendering](https://nextjs.org/docs/app/getting-started/server-and-client-components).
Reviewed September 12, 2026. Pinned Router/Query are implemented in the deployed release; see STATUS for verification.

Original code-confirmed causes addressed by this increment (not benchmark results):

- main.tsx chooses a screen once and navigation uses ordinary document links.
- Filter/detail URL changes use replaceState without popstate synchronization.
- Review selectedId changes refetch bootstrap, categories and the entire list.
- Receipts repeats bootstrap/list fetches; screens replace loaded content with skeletons.
- Review/Receipts do not consume the global currency selector for their original
  amount displays. Currency context reads URL state only initially.
- The backend applies no-store even to fingerprinted JS/CSS assets.
- /api/review performs sequential per-transaction suggestion/tag queries (N+1).

Proposed state contract: router owns URL state (page, owner, period, currency,
filters, sort, selected transaction/receipt, pagination). Meaningful committed
changes add history entries; typing may replace. Back/Forward restores the full
view and selection. Secrets, unsaved credentials, file contents and transient menus
are not URL state. Query owns server data, keyed by owner and normalized filters;
clear private cache on identity change. Keep cache in memory, not persisted ledger
copies in localStorage. Disable polling and focus/reconnect refresh; fetch on
initial navigation/explicit Refresh and invalidate affected queries after edits.

Preserve displayed rows while fetching, distinguish refreshing from first load,
restore scroll, and keep old currency labels paired with old amounts while new
conversions load. Show the selected display-currency equivalent with the original
bank amount clearly labeled. A missing equivalent must never relabel the original.
Use independent detail queries and invalidate only affected lists/totals on edits.

Backend is a separate increment: measure endpoint/query count and durations,
batch suggestion/tag retrieval, then add necessary pagination/indexes based on
measurements. Cache fingerprinted public assets privately/safely as appropriate;
keep sensitive APIs and receipt images protected. Do not add Redis, SSR or live
updates merely to compensate for avoidable refetching. TanStack Table is not needed
unless advanced table requirements actually arise.

## FX issue: date correction and quote refresh verified

The warning excludes transactions without a selected conversion, so totals are
partial rather than treating unknown conversions as zero. In a 2026 household
check, affected personal/unresolved outflows were 2 for UAH, 9 for EUR, 15 for USD,
and 17 for GBP, including pending amounts. Counts depend on filters and new imports.

Two causes were found. The approved source has today's quotes, but the database
has not loaded today's date. More importantly, FxRates.stored converts PostgreSQL
DATE to a UTC timestamp and slices it: on the server, a stored April 16 calendar
quote was read as April 15 (also reproduced for April 19, July 24 and September 11).
This can misselect the next day's rate as well as report missing quotes. Synthetic
EUR-to-UAH conversion reproduced the false missing result despite existing quotes.
The investigation was read-only. The subsequent isolated date fix and approved-source quote refresh are verified in STATUS; original ledger and report snapshots remain unchanged.

First isolated correction: preserve database calendar dates as YYYY-MM-DD without
passing through a timezone-sensitive instant; test existing PostgreSQL DATE values
under UTC and Europe/Riga, direct/inverse/cross rates and month/DST boundaries.
Then load missing approved-source days, verify coverage/totals and provenance, and
ensure daily quote ingestion stays current. Re-evaluate affected derived totals;
keep immutable original ledger and old report snapshots. Explain changed estimates
instead of overwriting historical report snapshots. Do not substitute NBU rates.
Add actionable coverage details (missing dates/currencies/affected records) to the
UI in a separate increment; this does not require a different rate provider.

## Approved atomic implementation sequence

1. FX date correctness and missing-day ingestion, independent of UI architecture.
2. Agreed router/query foundation and URL/back-forward tests, one screen first.
3. Transactions currency behavior, independent detail fetch, then Receipts navigation.
4. Admin-only settings and reversible visibility defaults with permission tests.
5. Resolver evidence/rule design, shadow evaluation, then narrowly approved activation.
6. Measured backend batching/performance improvements without financial changes.

Each increment gets a documented scope, focused tests, code review, commit, release
checks and updated status. No bundled visual redesign or unrelated schema rewrite.
