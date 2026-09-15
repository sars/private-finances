import { merchantTokens } from './merchant-names.js';

/**
 * Can one merchant be recognised across the many descriptions a bank prints for
 * it? (CAT-11.)
 *
 * This is the question the rule sediment turns on. 324 confirmed rules match
 * exactly one payment each because a description carries a reference number, a
 * terminal or a city, so every visit produces a new string and needs a new rule.
 * If a merchant can be identified across those variants, one entry replaces
 * dozens and the classifier gets a much stronger signal for nothing.
 *
 * The owner's reservation was whether it can be done reliably enough, so this is
 * measurement before commitment: the functions here decide nothing on their own
 * and reclassify nothing. `scripts/measure-merchant-clustering.mjs` runs them over
 * real descriptions and reports how well the clusters agree with categories a
 * person already chose.
 */

/**
 * The identifying key of a bank description, or null when it carries nothing
 * identifying at all.
 *
 * Reuses `merchantTokens`, which already drops legal forms, countries and cities,
 * and then takes the first surviving token. Numbers are dropped on top of that,
 * which receipt matching does not do: a receipt is compared against one candidate
 * so a shared digit run is harmless, whereas here "111" would become a merchant
 * of its own and pull unrelated payments together.
 */
export function merchantKey(description: string): string | null {
  const tokens = merchantTokens(description).filter(
    (token) => !/^\d+$/.test(token),
  );
  return tokens[0] ?? null;
}

export type ClusterMember = {
  description: string;
  /** The category path this payment already carries, when it has one. */
  category: string | null;
  /** True when a person chose that category, rather than an automatic pass. */
  decidedByPerson: boolean;
};

export type ClusterReport = {
  descriptions: number;
  /** Descriptions that produced a key at all. */
  keyed: number;
  clusters: number;
  /** Clusters holding more than one distinct description: the ones that would
   * actually replace several rules with one. */
  multiDescriptionClusters: number;
  /** How many distinct descriptions those clusters absorb. */
  absorbedDescriptions: number;
  /** Clusters where every categorised member agrees on the same leaf. */
  pureClusters: number;
  /** Clusters whose categorised members disagree. These are the risk: a merchant
   * key that spans two purposes must never silently reclassify either. */
  mixedClusters: number;
  /** Of the mixed ones, those that agree once rolled up to the top-level branch,
   * so the disagreement is Restaurants versus Delivery rather than Food versus
   * Transport. */
  mixedButSameBranch: number;
  /** Clusters with no categorised member, so purity says nothing about them. */
  unjudgedClusters: number;
  /** Mixed clusters where at least two members were decided by a person. A
   * disagreement between two human decisions is real, not a model slip. */
  mixedWithTwoHumanDecisions: number;
};

const branchOf = (path: string) => path.split(' / ')[0] ?? path;

/** Group descriptions by merchant key and measure how far the grouping agrees
 * with categories that already exist. Pure: no database, no side effects. */
export function clusterMerchants(
  members: readonly ClusterMember[],
): ClusterReport & { byKey: Map<string, ClusterMember[]> } {
  const byKey = new Map<string, ClusterMember[]>();
  let keyed = 0;
  for (const member of members) {
    const key = merchantKey(member.description);
    if (key === null) continue;
    keyed++;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(member);
    else byKey.set(key, [member]);
  }
  const report: ClusterReport = {
    descriptions: members.length,
    keyed,
    clusters: byKey.size,
    multiDescriptionClusters: 0,
    absorbedDescriptions: 0,
    pureClusters: 0,
    mixedClusters: 0,
    mixedButSameBranch: 0,
    unjudgedClusters: 0,
    mixedWithTwoHumanDecisions: 0,
  };
  for (const bucket of byKey.values()) {
    const distinct = new Set(bucket.map((m) => m.description));
    if (distinct.size > 1) {
      report.multiDescriptionClusters++;
      report.absorbedDescriptions += distinct.size;
    }
    const categorised = bucket.filter(
      (m): m is ClusterMember & { category: string } => m.category !== null,
    );
    if (!categorised.length) {
      report.unjudgedClusters++;
      continue;
    }
    const leaves = new Set(categorised.map((m) => m.category));
    if (leaves.size === 1) {
      report.pureClusters++;
      continue;
    }
    report.mixedClusters++;
    if (new Set(categorised.map((m) => branchOf(m.category))).size === 1)
      report.mixedButSameBranch++;
    const humanLeaves = new Set(
      categorised.filter((m) => m.decidedByPerson).map((m) => m.category),
    );
    if (humanLeaves.size > 1) report.mixedWithTwoHumanDecisions++;
  }
  return { ...report, byKey };
}
