import type { Kind } from './domain.js';

export type ReferenceCase = {
  expected: { kind: Kind; category: string | null };
  actual: { kind: Kind; category: string | null };
  authority: 'owner_confirmed' | 'reviewed_inference';
  split: 'development' | 'holdout';
};

/** Aggregate only: never return transaction descriptions, identifiers or amounts.
 * Abstention is measured separately from wrong approval. Inferred labels are not
 * presented as owner-confirmed ground truth; retain both authority strata.
 */
export function evaluateCategorization(cases: ReferenceCase[]) {
  const summarize = (rows: ReferenceCase[]) => {
    let correct = 0;
    let wrongApproval = 0;
    let abstained = 0;
    let safeAbstention = 0;
    for (const row of rows) {
      if (row.actual.kind === 'unresolved') {
        if (row.expected.kind === 'unresolved') safeAbstention++;
        else abstained++;
      } else if (
        row.actual.kind === row.expected.kind &&
        (row.expected.kind !== 'personal_expense' ||
          row.actual.category === row.expected.category)
      )
        correct++;
      else wrongApproval++;
    }
    const approved = correct + wrongApproval;
    const classifiable = rows.filter(
      (row) => row.expected.kind !== 'unresolved',
    ).length;
    return {
      cases: rows.length,
      correct,
      wrongApproval,
      abstained,
      safeAbstention,
      approvalPrecision: approved ? correct / approved : null,
      correctCoverage: classifiable ? correct / classifiable : null,
    };
  };
  return {
    overall: summarize(cases),
    ownerConfirmed: summarize(
      cases.filter((row) => row.authority === 'owner_confirmed'),
    ),
    inferred: summarize(
      cases.filter((row) => row.authority === 'reviewed_inference'),
    ),
    development: summarize(cases.filter((row) => row.split === 'development')),
    holdout: summarize(cases.filter((row) => row.split === 'holdout')),
  };
}
