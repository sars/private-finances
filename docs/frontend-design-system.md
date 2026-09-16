# Frontend design system: what we have, what to adopt, and in what order

Research and plan, September 16, 2026. Status: **researched and planned, not
built.** Nothing here has been implemented; each stage below is a separate piece
of work. The screen this plan exists to serve is the one already designed in
[analytics](analytics.md), which is why the component list is shaped around
period pickers, tree tables, drill links and stacked series rather than around a
generic admin dashboard.

## What the frontend is today

Measured, not estimated: 11,232 lines under `frontend/src`.

| Part | Lines | Note |
| --- | --- | --- |
| `Review.tsx` | 2,366 | Transactions: list, detail, refunds, replies, proposals |
| `Overview.tsx` | 1,365 | Home, and `/analytics` renders it with a flag |
| `Accounts.tsx` | 909 | |
| `Fx.tsx` | 856 | |
| `Categories.tsx` | 846 | |
| eight other screens | ~2,600 | |
| `components/ui/` | ~1,300 | 14 shadcn primitives |
| `lib/` | ~600 | |

The stack is current and correct: React 19.3, Vite 8.3, Tailwind 4.3,
shadcn/ui (new-york, neutral base, CSS variables), the unified `radix-ui`
package, TanStack Router 1.170 and Query 5.102, Recharts 3.10, lucide-react.
Nothing in this plan proposes replacing any of it.

The theme layer is already good and should be preserved as-is: a household
palette (`#236753` green primary), five chart tokens, a full dark theme,
`tabular-nums` for money, `prefers-reduced-motion` honoured, a skip link, and
focus-visible outlines.

### What is actually missing

1. **There is no chart layer.** The whole application renders two charts, both
   bar charts — one in `Overview.tsx`, one in `LlmBudget.tsx` — and each spells
   out its own `CartesianGrid`, `XAxis`, `YAxis`, `Tooltip` styling inline, about
   50 lines apiece. `components/ui/chart.tsx` does not exist.
2. **`Analytics.tsx` is four lines**: `<Overview analytics />`. The screen the
   owner's questions need has no code of its own.
3. **`money()` is defined four times** — in `Overview.tsx`, `Review.tsx`,
   `Reports.tsx` and `Fx.tsx` — each a near-copy handling minor units and
   currency exponent. Two more places call `Intl.NumberFormat` directly.
4. **Dates are five raw `<input type="date">`** in `Cash`, `Fx` (twice) and
   `Overview` (twice). There is no range picker and no shared period control,
   although every analytical screen needs one.
5. **Navigation is hand-rolled** — a `Sheet` on mobile, a flat list of ten links
   on desktop, with `/cash`, `/settings` and `/history` reachable but unlisted.
   There is no grouping, no keyboard access to screens, no breadcrumb.
6. **Tables are bespoke per screen.** No sorting, no column control, no
   virtualization; `Review.tsx` carries its own list, filter and selection logic.
7. **Feedback after a mutation is ad hoc.** No toast layer; each screen invents
   its own inline success and error text.
8. **Recharts is chunked badly.** It lands inside `LlmBudget-*.js` at 350 KB of
   a 1.2 MB build, so opening Home pulls the LLM-budget chunk.

The code quality itself is not the problem. Raw HTML controls are almost absent
(one `<button>`, one `<select>`, one `<table>` in 11k lines), sections are
labelled, amounts are tabular. What is missing is a layer between the shadcn
primitives and the screens, so that every screen re-solves money formatting,
period selection, empty states and chart styling by hand.

## Verdict

Keep the stack. Add the missing layer, and take it from the shadcn ecosystem by
copy-paste rather than by adding component-library dependencies. Everything
recommended below is MIT, already compatible with Tailwind v4 and React 19, and
in the case of charts is built on exactly the Recharts version we already run.

## What to adopt

Versions verified against the npm registry on September 16, 2026.

### 1. The shadcn chart layer — the single biggest win

`pnpm dlx shadcn@latest add chart` copies `components/ui/chart.tsx`: a
`ChartContainer` that wraps Recharts' `ResponsiveContainer`, turns a typed
`ChartConfig` into `--color-*` CSS variables, and restyles Recharts' internal
SVG classes to the theme (axis ticks to `muted-foreground`, grid to `border/50`,
focus outlines off); plus `ChartTooltip`/`ChartTooltipContent` and
`ChartLegend`/`ChartLegendContent` that read labels and colours from the same
config. It is built on Recharts v3 — the exact major we run — and it composes
Recharts rather than wrapping it, so a Recharts upgrade stays a Recharts upgrade.

This deletes the ~100 inline lines of axis styling we have, and it is the
prerequisite for the analytics screen's stacked series, because the series
colour, label and legend then come from one config object instead of being
repeated at every call site.

One caveat from the docs: `ChartContainer` needs an explicit `min-h-[…]` to be
responsive.

### 2. Navigation: sidebar, grouped information architecture, command palette

`shadcn add sidebar` gives `SidebarGroup` sections, three collapse modes
(`offcanvas`, `icon`, `none`), automatic mobile behaviour, a `cmd+b` shortcut,
submenus, badges and skeletons. It replaces the hand-rolled `Sheet` plus link
list, and the badge slot is where "12 awaiting review" belongs.

Ten flat links is past the point where a list reads. Grouping the thirteen
routes:

- **Money** — Home, Spending analytics, Transactions, Receipts, Cash
- **Setup** — Categories & rules, Accounts & exclusions, Bank connections,
  Currency conversion, Settings
- **System** — Reports, System health, LLM budget

`shadcn add command` (cmdk 1.1.1, MIT) adds a `⌘K` palette. In an application
with thirteen screens and a filter grammar, jumping straight to "Transactions,
Katya, September, unresolved" is worth more than any visual change. It is also
the right home for the combobox pattern the category picker needs.

### 3. Transactions on TanStack Table

`@tanstack/react-table` 9.2.4 (MIT) is headless and feature-opt-in in v9: you
declare only the features you use via `tableFeatures()`, so we pay for sorting
and column visibility and not for grouping we do not want. Paired with
`@tanstack/react-virtual` 3.14.13 (MIT) for windowing, the 4,073-row ledger —
and the several-times-larger ledger of a few years from now — scrolls without
pagination. Column definitions also give the tree table in the analytics design
a real implementation instead of nested `<div>`s.

This is the one place worth a dependency rather than a copy-paste, because the
table state machine is genuinely hard and is exactly what a headless library is
for.

### 4. A period control, once

`shadcn add calendar popover` brings react-day-picker 10.0.1 (MIT) and gives us
a proper range picker. It should be wrapped once as a project component holding
the presets the screens actually use — this month, last month, this year, last
12 months, custom — and the Riga-calendar-day semantics the backend expects, so
that the five raw date inputs and the preset row in `Overview.tsx` collapse into
one control used everywhere.

### 5. Mutation feedback

`shadcn add sonner` (sonner 2.0.8, MIT) gives one toast surface for "category
saved", "rule created", "consent renewed", and for the failures those currently
report inline in inconsistent ways. Small, and it removes a class of per-screen
invention.

### 6. The primitives we do not have yet

From shadcn's ~70, the ones this application has an actual use for:
`popover`, `command`, `checkbox`, `switch`, `toggle-group` (the
investments/exceptional three-way toggles the analytics design calls for),
`collapsible` (tree table rows), `scroll-area`, `alert`, `progress`,
`breadcrumb`, `empty`, `spinner`, and `drawer` (vaul 1.1.2) for mobile detail
panels where a `Sheet` is too heavy.

### 7. Registries to borrow from, not to depend on

- **Origin UI** (MIT, Tailwind v4, shadcn conventions) — several hundred
  copy-paste "particles": inputs, comboboxes, timelines, richer dialogs. Useful
  as a source for one component at a time.
- **Kibo UI** — composable pieces above shadcn's level: `Combobox`, `Table`,
  `Mini Calendar`, `Status`, `Relative Time`, `Pill`, `Ticker`. The relative-time
  and status pieces map onto our sync freshness and consent-expiry displays.
- **Tremor** (Vercel-owned, Tailwind v4 native, core MIT) — the best-looking
  KPI and chart blocks in the ecosystem. Worth reading for layout and density,
  but adopting it wholesale would give us a second component vocabulary beside
  shadcn's, which is a cost in itself. Borrow the layout, not the library.
- **Midday** — the closest-looking product to ours and a good visual reference,
  but AGPL-3.0. Look, do not copy code.

## Product patterns worth taking from other finance apps

Read against the owner's own requirements, not in place of them. Monarch, YNAB,
Tiller and Copilot converge on a handful of things we can use:

- **Every figure is a link into the payments behind it.** Already our invariant
  in the analytics design; the ecosystem confirms it is the single feature that
  makes a spending screen trustworthy.
- **One dataset, several shapes.** Monarch lets the same report be rendered as
  breakdown, trend, pie or treemap, grouped by category, group or merchant.
  Cheap for us once the aggregation endpoint exists, because it is a render
  switch over one response.
- **Drill by clicking the chart, not only the legend.** A bar segment and a
  legend entry should both be the drill link.
- **The period selector is sticky and global**, not per-card.
- **Incompleteness is shown, not hidden.** Ours goes further than the market —
  hatched provisional bars, missing-FX marks, the coverage strip reading "92%
  decided by you or your rules" — and that is a deliberate difference, not a gap
  to close.

## The system to put in place

Three layers, with a rule for each:

```
components/ui/        unmodified shadcn primitives — upgraded, never hand-edited
components/finance/   domain components — where our vocabulary lives
<Screen>.tsx          composition only
```

`components/finance/` is the part that does not exist today and is the actual
answer to "systematize". The initial set, each replacing something currently
repeated inline:

| Component | Replaces |
| --- | --- |
| `Money`, `AmountDelta` | four `money()` copies and two `Intl` call sites |
| `PeriodPicker` | five `<input type="date">` and the preset row |
| `FilterBar` | per-screen filter layouts in Overview, Review, Fx, Receipts |
| `KpiCard` | the metric-card block in `Overview.tsx` |
| `DrillLink` | the analytics design's "every figure is a link" |
| `CategoryBadge`, `OwnerBadge`, `SourceBadge` | ad-hoc badge styling |
| `CoverageStrip` | new, from the analytics design |
| `TransactionRow` | the row markup in Review, Overview and Receipts |
| `TreeTable` | new, from the analytics design |
| `SpendingChart`, `Sparkline` | the two inline Recharts blocks |
| `EmptyState`, `ErrorState`, `LoadingState` | per-screen variants |

Plus `lib/format.ts` as the single source for minor-unit money, currency
exponent, compact axis numbers, Riga dates and relative times.

Charts, when they are built, follow the project `dataviz` guidance and the
existing `--chart-1..5` tokens rather than introducing new colours.

## Staged plan

Each stage ships on its own and leaves the application working.

**Stage 1 — foundations, no redesign.** Add the chart primitive, sonner, and the
missing shadcn primitives. Write `lib/format.ts` and delete the four `money()`
copies. Move the two existing charts onto `ChartContainer`. Give Recharts its
own manual chunk so Home stops loading the LLM-budget bundle. Verifiable by
`pnpm check` plus a test that the shared formatter agrees with each copy it
replaces, on every currency in the ledger.

**Stage 2 — navigation and shell.** Sidebar with the three groups, awaiting-review
badge, `⌘K` palette, breadcrumbs on detail routes. This is the change the owner
will feel first and it touches one file plus the route table.

**Stage 3 — the analytics screen.** Build what [analytics](analytics.md)
specifies: the aggregation endpoint, period and bucket controls, the toggles
row, the stacked chart, the tree table, the coverage strip, drill links whose
totals equal the figure they came from by test.

**Stage 4 — Transactions on TanStack Table**, virtualized, with the finance
components above, which is where `Review.tsx` stops being 2,366 lines.

**Stage 5 — polish pass.** Empty, loading and error states everywhere from the
shared components; a density review at 390px and at desktop; the spacing
convention in [frontend navigation](frontend-navigation.md) applied uniformly.

## What this plan deliberately does not do

- **No chart library change.** Recharts 3 is what the shadcn chart layer targets;
  visx or ECharts would be more capable and more work for charts we do not need.
- **No dashboard template.** Every open-source shadcn dashboard starter assumes
  Next.js App Router and brings an auth and layout opinion we already have.
- **No second component vocabulary.** Tremor, ReUI and the block marketplaces are
  reading material; components enter this repository one at a time, as source.
- **No visual rebrand.** The palette, the dark theme and the typography stay.

## Cost

The build is 1.2 MB across lazy chunks today. Stage 1 is close to neutral — the
chart primitive is source, sonner is ~5 KB — and splitting Recharts into its own
chunk should make Home noticeably lighter. Stage 4 adds roughly 20 KB for table
and virtualizer while removing hand-rolled list code. Build time is unaffected;
no new build step, no new toolchain.
