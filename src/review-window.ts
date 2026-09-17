import { previousReportPeriod } from './reports.js';
import type { Transaction } from './repository.js';

export type ReviewWindow =
  'previous_month' | 'current_month' | 'historical' | '2026' | 'all';
export function reviewWindow(value: string | null): ReviewWindow {
  if (value === null) return '2026';
  if (
    !['previous_month', 'current_month', 'historical', '2026', 'all'].includes(
      value,
    )
  )
    throw new Error('invalid_review_window');
  return value as ReviewWindow;
}
export function withinReviewWindow(
  row: Pick<Transaction, 'bookedAt'>,
  window: ReviewWindow,
  now = new Date(),
): boolean {
  if (window === 'all') return true;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(row.bookedAt));
  const period = previousReportPeriod('month', now);
  const time = Date.parse(row.bookedAt);
  if (window === '2026') return day >= '2026-01-01';
  if (window === 'previous_month')
    return (
      day >= '2026-01-01' &&
      time >= Date.parse(period.from) &&
      time < Date.parse(period.to)
    );
  if (window === 'current_month')
    return time >= Date.parse(period.to) && time <= now.getTime();
  return day >= '2026-01-01' && time < Date.parse(period.from);
}
