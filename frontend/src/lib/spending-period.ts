export function rigaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function periodRange(period: string, now = new Date()) {
  const today = rigaToday(now);
  if (period === 'year') return ['2026-01-01', today];
  if (period === 'archive') return ['2025-01-01', '2025-12-31'];
  if (period === 'previous') {
    const start = new Date(today.slice(0, 7) + '-01T12:00:00Z');
    start.setUTCDate(0);
    const end = start.toISOString().slice(0, 10);
    return [end.slice(0, 7) + '-01', end];
  }
  return [today.slice(0, 7) + '-01', today];
}
