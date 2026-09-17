# Frontend navigation and query migration

Selected stack: TanStack Router 1.170.35 and Query 5.102.8, preserving React,
Vite and the existing component stack. The app shell persists across internal
navigation. Existing internal anchors are intercepted only for registered same-
origin screens; downloads, modified clicks, external links and bank-consent actions
retain browser behavior. Unknown routes are not treated as app navigation.

Review (`/review`) was the first query-backed screen and is now the review list:
payments still waiting for a decision, read page by page from `/api/transactions`
with `review=1` through an infinite query and a virtualised list (`PagedList`), so
the document holds only the rows in view however far the list goes. Its filters
(`who`, `q`), tab and selected payment belong to the URL; Back/Forward restores
them, and the search box writes to the URL only once typing pauses. A selected
payment uses the separate owner-scoped `detailOnly=1` endpoint and does not
reload the list. The count beside Review in the sidebar and the phone tab bar is
the same endpoint asked for one row.

Transactions (`/transactions`) is the browsing list on the same paged endpoint
and the same list component, the household by default. Its URL carries `from`,
`to`, `who`, `q`, `category`, `kind`, `pattern`, `min`, `max`, `receipts`,
`refunds`, `tag` and the four `include*` visibility overrides; Analytics drill
links are URLs of this form. The amount bounds are typed in the display
currency and sent as minor units.
Display values come from backend `reporting` conversions; original bank amounts
remain explicit, missing rates are visible, and estimates are marked. Pending
bank status and financial eligibility are not rewritten by this frontend work.

Bootstrap, categories, lists and details use private in-memory query keys, including
owner and relevant filters/currency. No polling, focus/reconnect refetching or
automatic request retries. Explicit Refresh and successful mutations invalidate
cached server data. Loaded lists remain visible while a new request completes;
failed refreshes do not erase already loaded records. Auth failures clear cached
financial data. Financial content is not persisted to browser storage.

Backend contract implemented and permission-tested: `/api/review?detailOnly=1&id=...` returns the same
ReviewData shape restricted to that authorized payment, and `display` returns
reporting currency/rows. Generic bank detail permissions remain owner-scoped.

Legacy screens keep existing loading logic until their incremental migration.
Do not claim the whole application shares a server-data cache yet. Initial tests
cover scalar/recognized route validation, actual Router Back/Forward with review
state and owner/currency query isolation; build/type checks accompany each change.

Receipts now shares the in-memory session/query cache;
photo expansion and attachment selection use URL state and candidate search is
bounded/debounced. Showing a photo does not refetch the receipt list. Printed
receipt amounts remain original evidence rather than estimated conversions.
Settings uses the admin API and versioned save, with server authorization still
required. Transactions exposes temporary URL visibility overrides and can reset
to household defaults. “Business-account payments” means account-purpose business,
with investment exceptions retained; it does not promise all non-personal kinds
are hidden. Overview and FX filters now use Router search state, so Back/Forward
and display currency no longer compete with manual history writes. Their existing
request logic remains a separate later cache migration; loaded totals stay visible
and retain their actual currency labels until the new response arrives.

Remaining-state audit: Reports owner/period now use URL fields; History reloads
when the route's payment ID changes without a document reload. Categories and
Accounts have no existing browsing tabs/filters to persist; edit/create drafts,
consent forms and menus remain local. Successful category/rule, account-purpose
and report mutations invalidate migrated financial caches. Legacy bootstrap
responses update the shared session; an owner change cancels/removes the previous
owner's financial cache before the new session is exposed. A rejected Query API
session clears financial cache once and blocks repeat requests until fresh
bootstrap/reload. Receipt-filter navigation never temporarily shows another
payment's receipt list as a placeholder. The UAH priority badge is explicitly
labeled independently of the chosen display currency.

Visual checks on the integrated synthetic app: at 390px, Period uses an 8px
label/control gap and the page has no horizontal overflow. Desktop dark-theme
layout, in-place currency updates, Settings save, and Receipts/Transactions
navigation with browser Back were checked. The production release and full restore are verified in STATUS.

## The shell

Stage 1 of [the frontend plan](frontend-plan.md). The screens are listed once,
in `components/shell/navigation.ts`, grouped Money / Setup / System, and three
surfaces read that list: the shadcn sidebar (off-canvas on the phone, a sheet
opened by the header button or the tab bar's "More"), a bottom tab bar under
768 px carrying Home, Analytics, Transactions and Receipts, and a ⌘K / Ctrl-K
command menu that jumps to a screen by name and loads only when first opened.
Every internal navigation — anchors, tabs, the command menu — goes through one
`goTo` in `main.tsx`, which carries the display currency along as before.
Settings appears only for an administrator. Primitives are shadcn's Base UI
flavour (`components.json` style `base-nova`); `asChild` became `render`, and a
Select reports `null` when cleared, which every handler now tolerates.

The app installs to a phone's home screen: `vite-plugin-pwa` writes the
manifest and a service worker that precaches only the built shell, fonts and
icons. Nothing under `/api` is cached and navigations always go to the server,
so financial data never rests in browser storage and a new release is picked up
on the next load. The server serves the root files this needs — fonts, icons,
`manifest.webmanifest`, `sw.js` — from an explicit allow-list, with the worker
marked `no-cache`.

## Spacing review convention

Every screen opens with `PageHeader` from `components/finance` — one `text-lg`
title line, one sentence, actions on the right — and cards sit on the design
scale (`rounded-lg`, `shadow-xs`); `frontend/DESIGN.md` is the reference. Use
the existing shadcn components and Tailwind spacing scale consistently. Stacked
labels and controls normally use gap-2 (8px); related filter groups use gap-4 (16px).
Allow controls and descriptive text to wrap on narrow screens, without compressing
labels against inputs. For changed layouts, inspect both phone and desktop widths,
long labels, loading/error states and keyboard focus. Prefer shared component fixes
over page-specific margin patches. These are defaults, not forced spacing for every
inline control or dense data row.

## Saved Telegram reply history

The Replies tab lists saved owner explanations, not only inputs awaiting review.
Confirmed and rejected suggestion outcomes retain the original reply text. Each
card shows saved-input status, processing outcome, Riga timestamp and a direct
Open payment action using the existing URL detail navigation. Payment details
show the same saved replies filtered to that transaction. Receipt of an explanation
is distinct from successfully interpreting or confirming a classification; failed,
stale or uncertain processing is labeled without hiding the saved input.

Backend contract: owner-scoped `/api/review` replies include status, workflow_state,
created_at, revision and transaction_description; `detailOnly=1` returns only the
selected payment's replies. No confirmation behavior changes and no polling were
added. Refresh explicitly retrieves current saved history and processing status.
