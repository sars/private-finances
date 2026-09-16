// The vocabulary screens compose from, one line each. Read this before
// writing a component: if the thing exists here, use it.
export { Choice, type ChoiceOption } from './choice'; // one value from a short list; replaces raw Select
export { Money } from './money'; // an amount in minor units, tabular, optionally signed
export { KpiCard, percentChange } from './kpi-card'; // label, amount, change vs the previous period; a link when it drills
export {
  PeriodPicker,
  periodPresets,
  presetPeriod,
  previousPeriod,
  type Period,
} from './period-picker'; // preset ranges plus a custom one; Riga calendar days
export { FilterBar, Field } from './filter-bar'; // a row of labelled controls
export { BarList, type BarListRow } from './bar-list'; // ranked horizontal bars; the phone-friendly breakdown
export { CategoryBar, type Segment } from './category-bar'; // one bar split into shares, legend with percentages
export { TreeTable, type TreeRow } from './tree-table'; // rolled-up tree with totals, expand, drill links
export { EmptyState } from './empty-state'; // nothing to show, and what to do about it
export { PageHeader } from './page-header'; // title, one line, actions
