const reportingCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
import type { Transaction } from './repository.js';
export type Filters = {
  from?: string;
  to?: string;
  currency?: string;
  category?: string;
  pattern?: 'routine' | 'exceptional' | 'unreviewed';
  scope?: 'spending' | 'excluded' | 'unresolved';
};
export function parseFilters(params: URLSearchParams): Filters {
  const from = params.get('from') || undefined,
    to = params.get('to') || undefined;
  for (const day of [from, to])
    if (
      day &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day + 'T00:00:00Z')) ||
        new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day)
    )
      throw new Error('invalid_filter_date');
  if (from && to && from > to) throw new Error('reversed_filter_dates');
  const currency = params.get('currency') || undefined,
    category = params.get('category') || undefined;
  if (currency && !/^[A-Z]{3}$/.test(currency))
    throw new Error('invalid_filter_currency');
  if (category && (category.length > 250 || !category.trim()))
    throw new Error('invalid_filter_category');
  const pattern = params.get('pattern') || undefined;
  const scope = params.get('scope') || undefined;
  if (pattern && !['routine', 'exceptional', 'unreviewed'].includes(pattern))
    throw new Error('invalid_filter_pattern');
  if (scope && !['spending', 'excluded', 'unresolved'].includes(scope))
    throw new Error('invalid_filter_scope');
  return {
    from,
    to,
    currency,
    category,
    pattern: pattern as Filters['pattern'],
    scope: scope as Filters['scope'],
  };
}
export function filterTransactions(
  rows: Transaction[],
  filters: Filters,
): Transaction[] {
  return rows.filter((row) => {
    const day = reportingCalendar.format(new Date(row.bookedAt));
    return (
      (!filters.pattern ||
        (row.spendingPattern?.pattern ?? 'unreviewed') === filters.pattern) &&
      (!filters.scope ||
        (filters.scope === 'spending'
          ? row.kind === 'personal_expense'
          : filters.scope === 'unresolved'
            ? row.kind === 'unresolved'
            : ['internal_transfer', 'investment', 'non_personal'].includes(
                row.kind,
              ))) &&
      (!filters.from || day >= filters.from) &&
      (!filters.to || day <= filters.to) &&
      (!filters.currency || row.currency === filters.currency) &&
      (!filters.category ||
        row.category === filters.category ||
        row.category?.startsWith(filters.category + ' / '))
    );
  });
}
