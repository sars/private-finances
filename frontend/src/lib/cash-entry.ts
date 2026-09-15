export function rigaCalendarDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function validCashAmount(value: string): boolean {
  return /^\d{1,10}(?:\.\d{1,2})?$/.test(value) && /[1-9]/.test(value);
}
