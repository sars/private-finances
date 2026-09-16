# Analytics: the owner's questions, and what each needs from the backend

Design, September 14, 2026, for HIST-5. Implements the reading side of
[ADR 0008](adr/0008-attributes-and-the-classification-pipeline.md); the tree
and roll-up semantics are ADR 0006's. Status: built in Stage 3 of
[the frontend plan](frontend-plan.md) on September 17, 2026 — `/api/analytics`
(`src/analytics-aggregation.ts`) answers `bucket`, `series` (none, category,
owner, kind), `depth` and `kinds` on top of the existing filter grammar and
`owner`; the screen is `frontend/src/Analytics.tsx`. Not yet in the grammar:
`account`, `tag`/`excludeTag`, `provisional` as a filter, and category node ids
(categories are still path strings), so drill links go to Home's category and
period filters rather than to Transactions. The build steps were B1–B3 of
[the work plan](classification-work-plan.md).

The owner considers this inseparable from classification: a good classification
is only visible through a view that answers real questions, and the question
they restated as the important one is being able to see which payments sit
under a category, month or week — to review them. So every figure on this
screen is a link into the payments behind it, and the totals a link produces
must equal the figure it came from, by construction and by test.

## What exists today

`/analytics` renders `Overview` with a flag. It fetches every transaction with a
display-currency conversion (`/api/overview?…&display=`), then groups client
side: one series over time at day, week or month granularity; a ranked category
list; recent payments. Filters live in the URL: owner, original currency, one
category (a path string, matched by prefix, with a dropdown built from the rows
already seen), spending pattern, and a three-way "money movements" scope.

Missing, against the owner's list: no account filter; no tag filter; one
category at a time and no way to compare two; one series only, so Kate's and
Rodion's spending cannot be seen side by side and investments cannot be a
separate line; no click from a bar or a category row to the payments in it;
"exclude investments" is only reachable as "personal expenses only", which also
drops the unresolved money the owner wants to keep seeing; nothing says how much
of a total was decided by a person, a rule, the model or a default; and the
category filter is a string, so a rename between two visits changes the URL's
meaning. Server-side aggregation does not exist; with 3,911 rows the
client-side grouping is fine, and this design keeps it possible to move the
grouping server-side later without changing the screen.

## Use cases, mapped

Each row names what the owner asked for, what answers it, and what is missing.

**All expenses for this year by month, also by week or by day.** Period presets
and granularity exist. Needs: the default period for this screen is the calendar
year to date, and the incompleteness strip (unresolved, provisional, missing FX)
is shown per bucket, not only in total, so a month that looks cheap because a
rate is missing says so.

**Top categories; choose particular categories for the chart; one category
over time.** Needs a category picker over the tree by node id, multi-select,
with a depth control ("branches" by default, or a chosen set of nodes at any
level). Selected nodes become series; unselected nodes roll into "everything
else" so the stacked total still equals the period total. A single selected node
over time is the same request with one series. Missing today: node ids in the
filter grammar, multi-select, series.

**Navigate from any figure into the transactions behind it.** Every bar
segment, every category row, every total is an anchor to `/review` carrying the
exact filter that produced it — period bucket, node subtree, owner, account,
tags, kinds, provisional. Missing today: the Transactions screen accepts only
part of this grammar, and Overview has no such anchors. The invariant, tested on
synthetic data for every bucket the aggregation returns: the sum of the rows the
drill link lists equals the figure.

**Toggle dimensions: exclude exceptional; exclude investments, or see them
separately and over time.** Two controls. *Investments*: hidden (default),
included in the total, or shown as their own series. The same control applies
to business spending. *Exceptional*: included (default) or excluded, and
"only exceptional" for the owner's other question. Needs: `kinds` as a
multi-value filter and `excludeTag` / `tag` filters. Exceptional becomes a tag
in A1 of the work plan; until then the control is wired to the existing pattern
filter and switches over with no screen change.

**Kate's and Rodion's expenses separately; filter by bank account.** Owner as a
series (two stacked or side-by-side bars per bucket) rather than only a filter.
Account as a filter and as a series. Missing today: the `account` filter on
`/api/transactions` and `/api/overview`, and series by owner or account.

**A total at any level: all food, restaurants only, groceries only.** The tree
roll-up. Shown as a tree table beside the chart: every branch with its rolled-up
total for the period, expandable to leaves, each row a drill link and a
"chart this" toggle. Missing today: the tree table, and node-based filtering.

**How much is spent on trips in general, for now.** The Travel branch total,
plus `Transport / Long distance` once flights move there (ADR 0008). The picker
answers it by selecting both; the tree table shows each. Per-trip totals with
dates are the trip tag's job later and are out of scope now.

**Out of scope now, and not foreclosed.** Alcohol from receipt line items needs
the payment split of REC-2/REC-3; nothing here stores anything per line. Per-trip
totals need the trip tag; the tag filter grammar is where they will plug in.

## The filter grammar

One grammar, parsed by `parseFilters`, accepted identically by
`/api/transactions`, `/api/overview` and the new aggregation endpoint, so a
drill link is the same query string as the figure it came from.

- `from`, `to` — Riga calendar days, as today.
- `owner` — `rodion`, `katya`, or absent for both.
- `account` — `source:accountId`, repeatable.
- `currency` — original currency, as today.
- `category` — node id, repeatable; each means the node and its subtree.
  The legacy path-string form is accepted for one release and resolved to the
  node, then dropped.
- `kinds` — comma-separated subset of the five kinds. Default for analytics is
  `personal_expense,unresolved`: spending, plus the money not yet placed, which
  stays visible as incompleteness. Replaces the three-way `scope`.
- `tag`, `excludeTag` — tag id, repeatable.
- `provisional` — `only`, `exclude`, or absent.
- `pattern` — removed with A1; until then unchanged.

The aggregation request adds `display` (conversion currency), `bucket`
(`day`, `week`, `month`), `series` (`none`, `category`, `owner`, `account`,
`kind`) and, for `series=category`, `depth` (1–3) or the selected `category`
ids.

## The aggregation endpoint

`GET /api/analytics?<grammar>&display=EUR&bucket=month&series=category&depth=1`

Computed from the same rows and the same `convertedSpending` conversion the
transaction list uses, then grouped; this is what makes drill totals equal by
construction. Net of refunds (ADR 0007), so a refunded purchase counts what it
finally cost.

Response, all amounts integer minor units of the display currency as strings:

```
{
  currency, bucket, series,
  buckets: [{ period, series: [{ key, label, netMinor, count,
                                 provisionalMinor, missingFx }] }],
  totals:  { netMinor, count, provisionalMinor, unresolvedMinor, missingFx },
  tree:    [{ id, parentId, name, depth, netMinor, count, provisionalMinor }],
  coverage:{ bySource: { human, identity, rule, memory, model, mcc, default,
                         account_policy, none }: { netMinor, count } }
}
```

`tree` is every node with its subtree rolled up for the filtered period, which
feeds the tree table and the picker without a second request. `coverage` is the
share of the money each `classification_source` decided — the owner's "trust
90–95%" as a number, and the figure that shows the catch-all and the defaults
falling month by month.

Two rules for the implementer. Missing FX is never zero: a bucket whose rows
lack a rate reports `missingFx` and the chart hatches it. And a bucket's
`series` sum equals its total, so `series=category` with a selection includes
an "everything else" key.

## The screen

`Analytics.tsx` becomes its own screen instead of an `Overview` alias, on the
existing stack (TanStack Query for the endpoint, Recharts, shadcn). The shared
components it needs — the period picker, the stacked chart wrapper, the tree
table, the drill link and the coverage strip — are Stage 2 and 3 of
[the frontend plan](frontend-plan.md), which sequences them before this screen
so they are built once rather than inline here. Layout, top
to bottom: period presets and the bucket control; a toggles row (investments
hidden / included / separate; exceptional included / excluded / only;
provisional shown hatched, with a count); the chart, stacked by the chosen
series; the tree table with roll-up totals, expand, "chart this" and a drill
link per row; a coverage strip reading, for example, "92% decided by you or
your rules · 5% by the model · 3% placed by default", each part a drill link.
Filters stay in the URL and survive Back/Forward, as Overview's already do.

Home (`Overview`) keeps its purpose — this period's total and the next review —
and gains only the coverage strip and the provisional count in its
incompleteness banner, so the two screens agree on what "awaiting" means.

## Verification

Synthetic tests: for every bucket and every series key the aggregation returns,
the transaction list with the same grammar plus the bucket's period sums to the
same `netMinor` and `count`; category roll-up of leaves equals the branch;
`kinds` default excludes investment and business and includes unresolved;
`excludeTag` removes tagged rows from every total, not only from the chart;
refund-reduced purchases count their net; missing FX is reported, not zeroed.
`scripts/category-diagnosis.sql` gains a coverage query so the same shares can
be checked against the live database without the screen.
