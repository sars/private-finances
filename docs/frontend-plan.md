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
- Stage 1: built. Primitives on Base UI (`base-nova`); the sidebar with
  Money / Setup / System groups, the phone tab bar, the ⌘K command menu
  (lazy), sonner, and the installable app with a shell-only service worker.
  The server now serves fonts, icons, manifest and worker from an explicit
  allow-list — Stage 0's Inter had in fact been falling back to the system
  font because `/fonts/` was never served. `Choice` is the first word of the
  vocabulary: Base UI's Select shows raw values unless handed labels, and the
  twenty-two pick-lists across the screens now go through it, guarded by
  `check_frontend.py`. Entry chunk 125 KB gzip. The awaiting-review badge
  waits for a count the session does not yet carry (Stage 2).
- Stages 2–5: not started.
