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

A payment has two pages. `/transactions/:id` shows it — header, explanations,
receipt, refunds, bank record — with Decision history and Review this payment
in its header; `/review?id=` is where it is decided. Both read the owner-scoped
`detailOnly=1` review endpoint, and `/transactions/:id/history` returns to the
payment page.
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
manifest and a service worker that precaches the built bundle, fonts and icons.
Nothing under `/api` is cached and navigations always go to the server, so
financial data never rests in browser storage and the shell always comes from
the release that is running. The server serves the root files this needs —
fonts, icons, `manifest.webmanifest`, `sw.js` — from an explicit allow-list,
with the worker marked `no-cache`.

### Moving an installed app to a new release

An installed app is resumed far more often than it is started, and iOS keeps
the same document alive for days. The plugin's own registration script runs on
the document's `load` event and never again, so a resumed app never checked;
a release could be live for a week while the phone sat on the previous one, and
deleting and reinstalling the app was the only reliable way out. Worse, the
worker was `autoUpdate`, which claims the open page the moment the new worker
activates and drops the old precache with it — so a page that had been open
across a release failed on the next lazily loaded screen, which asks for a
hashed file the release had already removed.

`frontend/src/lib/app-update.ts` replaces all of that, and its own comment
carries the reasoning. Four parts:

- **The app registers the worker itself** (`injectRegister: false`) and checks
  on its own schedule: every thirty minutes in the foreground, and on the way
  back from more than a minute in the background — the same moment the query
  cache is invalidated in `main.tsx`, because for an installed app returning to
  it is the closest thing to opening a page.
- **Two independent signals.** `registration.update()` re-fetches `sw.js`, and
  `/health/live` reports the running release, which the app compares against
  the release `/api/bootstrap` gave this document. A browser can hold a worker
  back under its own 24-hour update throttle long after the release has moved.
- **The new worker waits** (`registerType: 'prompt'`, workbox `skipWaiting` and
  `clientsClaim` both off). Nothing under a screen in use changes until the
  household says go, from the toast or from the version line in the sidebar
  footer, which also offers an on-demand check. Applying it posts
  `SKIP_WAITING` to the waiting worker and reloads once it has taken over.
- **A page that started before a release still recovers.** A stale dynamic
  import — from React's error boundary or Vite's `vite:preloadError` — reloads
  the document once per ten minutes. The shell is never cached, so the reload
  lands on the current release; the window keeps a genuinely broken build from
  reloading in a circle.

Four details follow from all of this and are easy to undo by accident, so
`scripts/check_frontend.py` holds them against the built output:

- **The shell is not precached.** `index.html` is deliberately absent from the
  worker's glob patterns. The server answers every screen route with the shell
  but has no `/index.html` route of its own, and a precache entry that 404s
  fails the entire install with `bad-precaching-response` — leaving nothing
  cached at all.
- **The manifest is fetched with credentials.** The browser, not the bundle,
  asks for `manifest.webmanifest`, and by default it omits credentials, which
  the authentication of the day answered with 401. The manifest is part of the
  shell and now answers without a session, but `useCredentials: true` stays: it
  puts `crossorigin="use-credentials"` on the link, and the moment anything at
  the root needs the session cookie again the omission returns. The response
  also needs
  `manifest-src 'self'` in the Content-Security-Policy: `default-src 'none'`
  is the fallback for manifests too, so without the directive the browser
  refuses the manifest before it is ever requested.
- **The worker hands over only when asked.** `sw.js` must carry the
  `SKIP_WAITING` message listener and exactly one `skipWaiting()` call — the one
  inside it — and must not call `clientsClaim`. Any other shape means the
  release replaces the app under a screen in use and the Update button has
  nothing to ask.
- **The entry chunk registers a worker.** With the injected script gone, the
  registration lives in the bundle; if `lib/app-update.ts` stops being reached
  from `main.tsx`, an installed app silently stops learning that releases exist.

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

## Balances

Balances (`/balances`) is the first screen built on the query cache from its
first line rather than migrated to it. It lists every account of the household
with what its bank last said the account holds, one card each, and a total in
the display currency. Two tabs separate the members and the selected one lives
in the URL (`?who=`), so Back and Forward restore it. Both members see both
tabs: the page reports the household, as the overview does, and decides nothing.

Arrange turns on dragging. The sortable primitive and the input library behind
it are a lazily loaded chunk of their own, entered only when arranging starts,
so the ordinary reading path does not carry them. Each person's order is stored
on the server under their own name through `POST /api/ui-layout` with the same
revision check the settings screen uses; it is a view preference and is
deliberately not part of the administrator-only household settings.

`tabScreens` now names the four screens on the phone's tab bar instead of taking
the first four of the Money group, so adding a screen to the sidebar cannot
silently reorder the buttons under somebody's thumb. Changing the tab bar is its
own decision.

See [balances](balances.md) for where the figures come from and what they cost.
