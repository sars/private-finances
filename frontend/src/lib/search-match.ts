/**
 * How a type-to-search list decides what to show.
 *
 * cmdk's own scorer matches loose subsequences, so typing "groc" also offers
 * categories that merely contain g, r, o and c somewhere in that order. Someone
 * searching a category list expects to see what they typed, so every word has
 * to actually appear; a match at the start ranks above one in the middle, and
 * anything else is dropped.
 */
export function searchMatch(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLocaleLowerCase();
  const words = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let best = 0;
  for (const word of words) {
    const at = haystack.indexOf(word);
    if (at === -1) return 0;
    best = Math.max(best, at === 0 ? 1 : 0.5);
  }
  return best;
}
