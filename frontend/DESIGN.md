# Design system

The one file an agent reads before touching a screen. Rules, not suggestions:
`scripts/check_frontend.py` enforces the ones a script can. The reference is
the Tremor dashboard (dashboard.tremor.so): quiet, dense, numbers loudest.

## Tokens

Colours exist only as the CSS variables in `src/index.css`; components use the
semantic Tailwind names and never a raw colour.

| Name                         | Use                                                             |
| ---------------------------- | --------------------------------------------------------------- |
| `background` / `foreground`  | page and body text                                              |
| `card`                       | surfaces: cards, popovers, sheets                               |
| `primary`                    | one accent: buttons, active state, the main series              |
| `muted` / `muted-foreground` | secondary surfaces and secondary text                           |
| `border`                     | every hairline                                                  |
| `positive` / `negative`      | deltas and status only, never decoration                        |
| `destructive`                | destructive actions                                             |
| `chart-1` … `chart-6`        | series, in this order: blue, emerald, violet, amber, gray, cyan |

Radius: `rounded-md` for controls, `rounded-lg` for cards. Shadows: `shadow-xs`
on cards, nothing larger. Dark mode is a token swap; no `dark:` colour classes
in components.

## Type

Inter, self-hosted. Scale, and there is nothing outside it:

| Role                            | Classes                                |
| ------------------------------- | -------------------------------------- |
| Page title                      | `text-lg font-semibold tracking-tight` |
| Card title                      | `text-sm font-medium`                  |
| KPI value                       | `text-2xl font-semibold tabular-nums`  |
| Body                            | `text-sm`                              |
| Meta, axis ticks, table headers | `text-xs text-muted-foreground`        |

Money is always `tabular-nums`, formatted by `lib/format.ts`, negative with a
true minus sign (−), currency after the number.

## Space and density

Tailwind's scale only: `gap-2` within a control group, `gap-4` between related
groups, `gap-6` between sections. Card padding `p-4`, `p-6` on desktop. Rows
are 40 px on desktop and at least 44 px on the phone. Pages are one column
under 1024 px.

## Components

Compose from `src/components/finance/index.ts` first, `src/components/ui/`
second. Never edit a file in `components/ui/`; re-add it from the registry.
Do not write a new component when an existing one takes a prop. Every figure
that summarises money is a link to the payments behind it.

## Charts

Recharts, imported only inside `src/components/charts/`, loaded lazily. Rules:
no axis lines, no tick lines, hairline horizontal grid (`border`, dashed 3 3),
ticks `text-xs muted-foreground`, strokes 2 px, no dots, bars radius 4 and at
most 28 px wide, tooltip a small `card` with a `border`, legend as text with a
colour dot. Series take `chart-1` … `chart-6` in order; the main series is
`primary`.

On the phone (`< 640px`): prefer `BarList` (ranked horizontal bars), a
`CategoryBar` (one segmented bar) or a sparkline over an XY chart. Where an XY
chart stays: no Y axis, at most five X ticks, height `h-48`, tooltips on tap.

## Phone

Design at 390 px first. Tables become card rows under 640 px. Detail views
open as a bottom drawer on the phone and a side sheet on desktop. No horizontal
page scroll, ever; long text truncates with a title attribute.

## Don't

No hex colours in `.tsx`. No `Intl.NumberFormat` outside `lib/format.ts`. No
`<input type="date">`; use `PeriodPicker`. No raw `<table>`; use the data table
or card rows. No raw `Select`; use `Choice`, which carries the labels Base UI
needs and never reports an empty pick. No `asChild`; Base UI composes with
`render={<a href … />}`. No new spacing values, no new font sizes, no new
shadows.
