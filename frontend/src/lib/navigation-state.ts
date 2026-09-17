export const appPaths = [
  '/',
  '/analytics',
  '/review',
  '/transactions',
  '/cash',
  '/receipts',
  '/categories',
  '/ops',
  '/fx',
  '/accounts',
  '/balances',
  '/reports',
  '/connections',
  '/imports',
  '/settings',
];
export function isAppPath(path: string) {
  return (
    appPaths.includes(path) ||
    /^\/transactions\/[0-9a-f-]{36}(?:\/history)?$/.test(path)
  );
}
export function stringSearch(
  input: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([, v]) =>
          typeof v === 'string' ||
          typeof v === 'boolean' ||
          typeof v === 'number',
      )
      .map(([k, v]) => [k, String(v)]),
  );
}
export const displayCurrencies = ['UAH', 'EUR', 'USD', 'GBP'];
export function validDisplay(value: unknown) {
  return typeof value === 'string' && displayCurrencies.includes(value)
    ? value
    : undefined;
}
export function reviewSearch(
  input: Record<string, unknown>,
): Record<string, string> & { all: string; window: string } {
  const value = stringSearch(input);
  const windows = [
    'current_month',
    'previous_month',
    'historical',
    '2026',
    'all',
  ];
  return {
    ...value,
    all: value.all === '0' ? '0' : '1',
    window: windows.includes(value.window ?? '')
      ? value.window!
      : 'current_month',
  };
}
