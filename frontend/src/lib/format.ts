// The one place numbers become text. Amounts arrive as integer minor units in
// strings (the server never sends floats); formatting keeps them exact and
// only chart plotting converts to a Number.
const exponents: Record<string, number> = {
  UAH: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  PLN: 2,
  CHF: 2,
  CZK: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
};
export function exponentOf(currency: string) {
  return exponents[currency];
}
/** "−1,234.56 EUR"; a true minus sign, thousands separated, currency after. */
export function money(minor: string, currency: string) {
  const value = BigInt(minor),
    absolute = (value < 0n ? -value : value).toString();
  const exponent = exponents[currency];
  if (exponent === undefined)
    return `${value < 0n ? '−' : ''}${absolute} minor units ${currency}`;
  const digits = absolute.padStart(exponent + 1, '0');
  const whole = (exponent ? digits.slice(0, -exponent) : digits).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  );
  return `${value < 0n ? '−' : ''}${whole}${exponent ? `.${digits.slice(-exponent)}` : ''} ${currency}`;
}
/** Minor units as a plotting number in major units; charts only. */
export function toNumber(minor: string, currency: string) {
  return Number(minor) / 10 ** (exponents[currency] ?? 0);
}
/** 12,345 → "12K"; axis ticks. */
export function compact(value: number) {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
/** Decimal USD strings from the LLM budget, which are labels, not accounting. */
export function usd(value: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: Number(value) > 0 && Number(value) < 0.01 ? 4 : 2,
  }).format(Number(value));
}
