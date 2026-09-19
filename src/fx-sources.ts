/**
 * The two stored FX sources, in the order the application trusts them.
 *
 * This list is the selection order, and it is deliberately not alphabetical.
 * The store used to fall back on sorting quotes by source string, which made
 * precedence an accident of spelling: `Minfin bank average midpoint` sorts
 * before `PrivatBank commercial midpoint`, so an alphabetical winner would have
 * silently demoted the owner's approved primary the day a second source was
 * added. Order lives here, not in the alphabet.
 *
 * Neither source is the National Bank. Both are commercial rates people
 * actually trade at, which is the whole point of the pair.
 */
export const PRIVATBANK_SOURCE = 'PrivatBank commercial midpoint';
export const MINFIN_SOURCE = 'Minfin bank average midpoint';

/** Most trusted first. PrivatBank is one bank's own quote; Minfin is the
 * average across Ukrainian banks and is asked only when PrivatBank is silent. */
export const FX_SOURCE_PRECEDENCE: readonly string[] = [
  PRIVATBANK_SOURCE,
  MINFIN_SOURCE,
];

/**
 * Rank for selection. An unrecognised source sorts after every declared one, so
 * a name nobody has ranked can never displace a source the owner approved.
 */
export function fxSourceRank(source: string): number {
  const index = FX_SOURCE_PRECEDENCE.indexOf(source);
  return index === -1 ? FX_SOURCE_PRECEDENCE.length : index;
}

/** The short name a screen shows. The stored string names the method too, which
 * belongs in provenance rather than in a table the owner reads at a glance. */
export function fxSourceLabel(source: string): string {
  if (source === PRIVATBANK_SOURCE) return 'PrivatBank';
  if (source === MINFIN_SOURCE) return 'Minfin bank average';
  return source;
}

/** Ranked first, then by name, so two unranked sources still order stably. */
export function compareFxSources(a: string, b: string): number {
  return fxSourceRank(a) - fxSourceRank(b) || (a < b ? -1 : a > b ? 1 : 0);
}
