// Legal forms and geography carry no identifying power and are exactly what makes a
// registered name ("SIA RIMI LATVIA") differ from a card description ("RIMI MR Marijas").
const merchantStopWords = new Set([
  'sia',
  'as',
  'ik',
  'ooo',
  'ltd',
  'llc',
  'inc',
  'gmbh',
  'ag',
  'oü',
  'ou',
  'uab',
  'sp',
  'zoo',
  'z.o.o',
  'bv',
  'nv',
  'sa',
  'srl',
  'plc',
  'latvia',
  'latvija',
  'lv',
  'riga',
  'rīga',
  'ukraine',
  'ukraina',
  'kyiv',
  'kiev',
  'estonia',
  'lithuania',
  'europe',
  'eu',
  'store',
  'shop',
  'market',
  'veikals',
  'tirgus',
  // The list was Latin-script only, which made Ukrainian legal forms and ordinary
  // words look like merchant names. Measuring merchant clusters on the real
  // ledger found "поповнення" (top-up) heading the largest cluster of all, 201
  // payments wide, pulling phone top-ups and donations together because the word
  // they share is the only word the rule could see; "фоп" and "тов", which are
  // the Ukrainian sole trader and limited company forms, behaved exactly like the
  // "sia" already listed above.
  'фоп',
  'фо-п',
  'тов',
  // A bank prints the same forms transliterated as often as in Cyrillic.
  'fop',
  'tov',
  'pp',
  'kp',
  'пп',
  'кп',
  'дп',
  'ат',
  'пат',
  'тзов',
  'поповнення',
  'платіж',
  'платеж',
  'оплата',
  'переказ',
  'перевод',
  'послуги',
  'сервіс',
  'магазин',
  'паркінг',
  'парковка',
  'освітні',
  'освітній',
  'україна',
  'украина',
  'київ',
  'львів',
  'одеса',
  'харків',
  // Latin-script words that identify nothing and had slipped through: a
  // description beginning "WWW…", "THE …" or "NEW …" is not a merchant called
  // www, the or new.
  'www',
  'the',
  'new',
  'com',
  'ua',
]);
// Historical rule, kept as the fallback when a name is nothing but stop-words.
const normalizeMerchant = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/^sia(?:\s+|(?=["“]))/u, '')
    .replace(/["“”]/gu, '')
    .trim()
    .replace(/\.lv$/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
/** Identifying parts of a merchant name: no legal form, no country or city, no
 * one/two-letter fragments. Pure and exported so the rule can be unit-tested. */
export function merchantTokens(name: string): string[] {
  return words(
    name
      .toLowerCase()
      .trim()
      .replace(/["“”'’`]/gu, '')
      .trim()
      .replace(/\.(lv|com|eu)$/u, ''),
  ).filter((w) => w.length >= 3 && !merchantStopWords.has(w));
}
/** True when the bank description still carries an identifying part of the receipt
 * merchant. A four-character-or-longer token may appear inside a longer word
 * ("RIMI" in "RIMIMRMARIJAS"); a three-character token must be a whole word, so
 * "IKI" does not match "PIKIS". */
export function merchantMatches(
  merchant: string,
  description: string,
): boolean {
  const tokens = merchantTokens(merchant);
  const haystack = normalizeMerchant(description);
  const whole = normalizeMerchant(merchant);
  const descriptionWords = words(description);
  if (tokens.length === 0 && whole.length >= 4 && haystack.includes(whole))
    return true;
  if (
    tokens.some((token) =>
      token.length >= 4
        ? haystack.includes(token)
        : descriptionWords.includes(token),
    )
  )
    return true;
  // A bank prints the brand abbreviation ("H&M") where the receipt prints the
  // registered name it stands for ("H&M Hennes & Mauritz"). Its letters survive
  // as one- and two-character fragments that carry no identifying power on their
  // own, so the token rule cannot see them. A prefix, never a substring: an
  // abbreviation must begin the other name, so "hm" does not match "Rathmann".
  const [shorter, longer] =
    whole.length <= haystack.length ? [whole, haystack] : [haystack, whole];
  return shorter.length >= 2 && longer.startsWith(shorter);
}
