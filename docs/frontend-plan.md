# Frontend plan: one vocabulary, Tremor's design, built for AI-assisted work

Agreed with the owner on September 17, 2026, after the research recorded in the
September status archive. This document replaces the earlier design-system
draft; where the two disagree, this one is current. Stage status lives at the
end and is updated as stages land.

## What the owner asked for

A consolidated frontend that is efficient to develop with an AI agent, uses
less code rather than more, looks like the Tremor dashboard
(dashboard.tremor.so), works well on the phone for every screen, installs to
the home screen, and loads fast. English only for now. Accessibility beyond
what the primitives give for free is not a criterion.

## Decisions

**Stack stays: Vite, React 19, TanStack Router and Query, Tailwind 4, shadcn.**
Next.js was considered and rejected: the app is a private single-page app
behind Tailscale with its own API, so server rendering buys nothing and costs a
heavier build and a routing rewrite. The best free reference for our exact
stack is [shadcn-admin](https://github.com/satnaing/shadcn-admin) (MIT, Vite +
TanStack Router, 31 route files: dashboard, tasks, users, settings, auth,
errors, command menu).

**Primitives move to Base UI**, shadcn's default since July 2026. Radix and
Base UI coexist in one project and shadcn ships a progressive migration skill
(`pnpm dlx skills add shadcn/ui`; `asChild` becomes `render`). Screens migrate
one at a time; `Review.tsx` last, once the vocabulary it needs exists.

**Tremor is the design specification, not a dependency.** Its repository has
had no feature since April 2025 and its components hardcode Tailwind's palette,
so we take the look and leave the code. What defines the look: a quiet left
sidebar with grouped links; a page title; a date range with a comparison period
and an Edit control; KPI cards showing value, delta and the previous period's
value; a metric grid; neutral typography, hairline borders, numbers as the
loudest element. Tremor's charts are Recharts underneath, so the look we want is
reachable with the library we already run.

**Colours are Tremor's defaults, set directly as CSS variables** — blue-500
primary, Tailwind gray neutrals, dark background `#090E1A`, emerald and red for
positive and negative deltas, a chart palette of blue, emerald, violet, amber,
gray and cyan. Inter is self-hosted (four woff2 subsets under
`frontend/public/fonts`), because the stylesheet already asked for it and
nothing loaded it.

**Charts stay on Recharts, confined and lazy.** Only `components/charts/` may
import it, and it loads as its own chunk on the screens that draw one. Charts
follow Tremor's rules: no axis lines, hairline grid, muted ticks, 2 px strokes,
no dots, legend as text with a colour dot, tooltip as a small card. On the
phone most breakdowns are not XY charts at all: `BarList` (ranked horizontal
bars), `CategoryBar` (one segmented bar) and sparklines are HTML and read at
390 px. Where an XY chart remains on the phone it drops the Y axis and most
ticks and answers taps.

**Sources**, all MIT and all verified this week: shadcn/ui and its free blocks
(sixteen sidebars, dashboard, login, calendars, chart blocks); shadcn-admin for
the shell, settings, error and auth patterns; [ReUI](https://reui.io) for the
free `tree`, `filters` and `date-selector` primitives; [Dice UI](https://diceui.com)
for the data table (eight filter kinds, sorting, pinning, selection with an
action bar, URL state). Origin UI is excluded: its repository now redirects to
Cal.com's `coss`, which is AGPL.

**No MCP servers.** The shadcn CLI already does what the shadcn MCP server does
(`shadcn search @reui -q grid`, `shadcn view @diceui/data-table`,
`shadcn add …`), and the agent has a shell. Tool definitions loaded into every
turn for a capability that exists would be pure cost.

**Vendor what we render, nothing more.** Registries are the example library,
reachable in one CLI call; a folder of a thousand examples is context cost and
maintenance debt. `components/ui/` holds only primitives we use, unmodified.

**Phone: every screen.** A bottom tab bar on phone (Home, Analytics,
Transactions, Receipts, More); tables become cards under 640 px; detail views
open as a bottom drawer. Progressive web app through `vite-plugin-pwa`; the
service worker caches only the shell and static assets and treats `/api` as
network-only, so financial data is never persisted in the browser.

## The development system — five small files

```
frontend/DESIGN.md                        tokens, type scale, spacing, chart and phone rules, do/don't
frontend/src/components/finance/index.ts  the vocabulary, one export per line with a comment — the inventory
scripts/check_frontend.py                 design lint and bundle budget, part of `pnpm check`
scripts/shots.ts                          Playwright renders routes at 390 and 1280 to PNG
.claude/skills/frontend-screen/SKILL.md   how a screen is built: read DESIGN.md and the barrel, compose, shots, check
```

`check_frontend.py` fails on: a hex colour in a `.tsx` outside the tokens;
`Intl.NumberFormat` outside `lib/format.ts`; an import of `recharts` outside
`components/charts/`; an entry chunk over 150 KB gzip or containing chart code.
Screenshots cost roughly width × height ÷ 750 tokens — under 2,000 for a phone
and a desktop shot — and are taken once per finished screen, not per edit.

## Stages

Each stage is one pull request gated by `pnpm check` (which runs
`check_frontend.py`) and screenshots at 390 and 1280. Every stage leaves the
application working and deployable.

0. **Foundation.** Tremor tokens and Inter; Recharts in its own lazy chunk;
   `DESIGN.md`, `check_frontend.py`, `shots.ts`, the skill. Deliverable: the
   current app in the new palette, screenshotted at both widths.
1. **Shell.** Base UI primitives; shadcn Sidebar with Money / Setup / System
   groups and an awaiting-review badge; command menu from shadcn-admin; bottom
   tab bar on phone; PWA manifest and service worker; sonner for feedback.
2. **Vocabulary and Home.** `lib/format.ts` replaces four `money()` copies;
   `Money`, `KpiCard`, `PeriodPicker` with comparison, `FilterBar`, `BarList`,
   `CategoryBar`, `EmptyState`. Home rebuilt in the Tremor overview layout.
3. **Charts and Analytics.** shadcn chart layer styled to Tremor's rules;
   `SpendingChart`, `Sparkline`, phone variants. The Analytics screen and its
   aggregation endpoint per [analytics](analytics.md), with ReUI's tree for
   the category roll-up.
4. **Transactions.** Dice UI data table carrying our filter grammar and URL
   state (nuqs' TanStack Router adapter, experimental; ReUI's grid is the
   fallback); card rows on phone; detail in a drawer on phone and a sheet on
   desktop; forms onto the vocabulary; `Review.tsx` to Base UI last.
5. **The rest.** Categories, Accounts, Currency, Receipts, Connections, Health,
   Reports, Settings (shadcn-admin's pattern), Cash, History, LLM budget onto
   the shell and vocabulary; [frontend navigation](frontend-navigation.md) and
   the roadmap updated.

## Expected effect

The frontend is 11,232 lines today with two charts, four `money()` copies, five
raw date inputs and a 2,366-line Transactions screen. The stages remove the
copies, the hand-rolled navigation and table logic, and per-screen empty and
error markup; the result should sit nearer 6–7 thousand lines with more screens
working better. First paint falls from about 200 KB gzip to about 120 KB once
Recharts leaves the entry chunk.

## Status

- Stage 0: deployed as `ca7ca14` on September 17. Tremor tokens and self-hosted Inter; Recharts in a lazy
  `charts` chunk (Rolldown needed `includeDependenciesRecursively: false`, or
  it dragged React into the chunk and the entry imported it eagerly); the entry
  is 103 KB gzip and carries no chart code, checked by `check_frontend.py` on
  every `pnpm check`; one `money` in `lib/format.ts` replacing five copies;
  `BarSeries` as the only Recharts consumer; `DESIGN.md`, `shots.ts` and the
  `frontend-screen` skill in place. Screens themselves are unchanged.
- Stage 1: deployed as `393a3fa` on September 17. Primitives on Base UI (`base-nova`); the sidebar with
  Money / Setup / System groups, the phone tab bar, the ⌘K command menu
  (lazy), sonner, and the installable app with a shell-only service worker.
  The server now serves fonts, icons, manifest and worker from an explicit
  allow-list — Stage 0's Inter had in fact been falling back to the system
  font because `/fonts/` was never served. `Choice` is the first word of the
  vocabulary: Base UI's Select shows raw values unless handed labels, and the
  twenty-two pick-lists across the screens now go through it, guarded by
  `check_frontend.py`. Entry chunk 125 KB gzip. The awaiting-review badge
  waits for a count the session does not yet carry (Stage 2).
- Stage 2: deployed as `25e513d` on September 17. The vocabulary — `Money`, `KpiCard` (amount, change
  against the period of equal length just before, the previous figure, a link
  when it drills), `PeriodPicker` (presets plus a custom range in a popover),
  `FilterBar`/`Field`, `BarList`, `EmptyState`, `PageHeader` — and Home
  rebuilt on it in the Tremor layout: title line, period control with
  Filters behind one button, the three KPI cards comparing with the previous
  period (a second `/api/overview` request in parallel), the chart without a
  Y axis on the phone, "Where it went" as a bar list. A `warning` token
  replaces the ad-hoc amber classes. Not yet: `CategoryBar` (nothing needs it
  before Analytics) and drill links from categories (the filter grammar comes
  with Stage 3).
- Stage 3: deployed as `69d91c2` on September 17. `/api/analytics` aggregates the same converted rows the
  list uses into day/week/month buckets and series by category (at a chosen
  depth), person or kind, rolls the category tree up, and reports the share
  each classification source decided; a test proves every bucket's series sum
  to the total and that a bucket's own period query reproduces its figure.
  The Analytics screen is its own file at last: period picker, bucket / split /
  depth / investments-and-business / person controls, three KPI cards with the
  previous-period delta, a "who decided the money" bar, the stacked chart (the
  five largest series plus "Everything else" so buckets still stack to their
  total), the largest branches as a bar list, and the rolled-up tree with
  expand and drill links. `TreeTable` and `CategoryBar` join the vocabulary.
  Drill links go to Home's category and period filters until Transactions
  speaks the grammar (Stage 4). Not yet: account and tag filters, provisional
  as a filter, node-id categories.
- Stage 4: deployed as `2655695` on September 17, narrower than planned and
  for stated reasons. The payment
  list is one dense `TransactionRow` per payment inside one card instead of a
  card each — the badges, history link and action stay, the height halves —
  and the filters sit on `FilterBar`/`Field` with Base UI checkboxes. No data
  grid library: Dice UI's registry has no Base UI table, and ReUI's grid brings
  TanStack Table v9 whose API changed in August; the list has never needed
  sorting or columns, so the dependency is deferred until it does. No drawer:
  the payment detail is a full page on purpose (explanation-first review), so
  the planned sheet/drawer would have undone a product decision. Review's move
  to Base UI happened in Stage 1 and held. Not yet: Transactions accepting the
  analytics grammar (period, category), so drill links still go to Home.
- Stage 5: first pass deployed as `15eae42` on September 17. Every remaining screen — Categories, Accounts,
  Currency conversion, Bank connections, Reports, System health, Cash,
  Decision history, Receipts, Settings — opens with the same `PageHeader`
  (one `text-lg` title line, one sentence, actions right) instead of its own
  eyebrow-and-3xl heading, and cards sit on the design scale (`rounded-lg`,
  `shadow-xs`) throughout.
- Stage 5, second pass: deployed as `eedcc32` on September 17. The filter rows on Currency conversion,
  Reports and Bank connections use `FilterBar`/`Field`, and Currency's two
  date inputs became the `PeriodPicker`, so no screen writes a date input by
  hand any more. Home lost its dead `analytics` branch — Analytics has been
  its own screen since Stage 3 — which removed the last raw `<table>`s; the
  historical-estimates toggle those tables served moved to the Analytics
  screen as `components/historical-estimates.tsx`, on the `Table` primitive,
  loading `/api/overview` only when switched on. `check_frontend.py` now
  refuses a raw `<table>` outside `components/ui/`. Decided rather than
  deferred: drill links from Analytics keep going to Home, because Analytics
  shows the household while Transactions shows only the signed-in owner's
  payments by design, so Home is the screen whose totals can match.
  Categories and Accounts already compose from `Label`, `Input` and `Choice`
  and needed nothing.
- Closing fix, deployed as `7a78a80` on September 17: the fifty-one warning
  colours still written as Tailwind amber classes moved to the `warning`
  token, the account chip's tones onto the neutrals and chart series, and
  `check_frontend.py` refuses any palette class outside `components/ui` so the
  colour rule is enforced rather than remembered. The plan is complete.

## After the plan: review and transactions become two screens

Agreed with the owner on September 17, 2026, after the plan closed. Reviewing
is one task and browsing is another, so they get their own screens, both
reading the paged `/api/transactions` endpoint (see [performance](performance.md))
through one virtualised list, and both showing the household with a "Whose"
filter. The payment itself splits the same way: a review page that leads with
the decision, and a view page that leads with the facts.

- Step 1, merged as PR #30: the endpoint pages, filters and counts in SQL;
  the 3,000 UAH priority is retired everywhere.
- Step 2: `/review` is the review list — only payments still waiting for a
  decision, the signed-in member's by default, a search box, no period and no
  visibility toggles (none of them can change a review list). Rows are
  `PaymentRow` on `PagedList`: the account badge with its holder, the day and
  the clock time where the bank gives one, account, category, what it cost,
  and the facts as badges. The sidebar and the phone tab bar carry the count
  of what waits for the signed-in member. Explanations and AI history stay as
  tabs here and are fetched only when opened. The payment page under
  `/review?id=` is unchanged until step 4.
- Step 3: `/transactions`, the browsing list, with the period picker and the
  full filter panel; Analytics drill links land here.
- Step 4: the payment page split into `/review/:id` (decision first, saved
  explanations inside the decision block) and `/transactions/:id` (facts,
  receipt, refunds, bank record without the cashback line, decision history).
