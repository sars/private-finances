export type ExplanationSuggestion = {
  kind:
    | 'unresolved'
    | 'personal_expense'
    | 'internal_transfer'
    | 'investment'
    | 'non_personal';
  category: string | null;
  explanation: string;
  confidence: number;
  /** Tag names the suggestion applied, absent on suggestions made before tags. */
  tags?: string[];
};
export function explanationSuggestion(
  value: unknown,
): ExplanationSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    ![
      'unresolved',
      'personal_expense',
      'internal_transfer',
      'investment',
      'non_personal',
    ].includes(String(row.kind)) ||
    !(row.category === null || typeof row.category === 'string') ||
    typeof row.explanation !== 'string' ||
    typeof row.confidence !== 'number' ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1 ||
    // The server restricts tags to the household's own list; here it only has
    // to be a list of strings, so a malformed one cannot reach the form.
    !(
      row.tags === undefined ||
      (Array.isArray(row.tags) &&
        row.tags.length <= 20 &&
        row.tags.every((tag) => typeof tag === 'string'))
    )
  )
    return null;
  return row as ExplanationSuggestion;
}
export function suggestionFeedback(status: string | undefined) {
  if (status === 'proposed' || status === 'ready')
    return 'Explanation saved. Check the suggested fields below, then confirm your decision.';
  if (status === 'budget_exhausted' || status === 'waiting')
    return 'Explanation saved. AI is currently unavailable under the spending limit; you can choose the fields yourself.';
  if (status === 'disabled')
    return 'Explanation saved. AI suggestions are unavailable; you can choose the fields yourself.';
  if (status === 'stale')
    return 'Explanation saved. The payment changed; refresh it before confirming a decision.';
  return 'Explanation saved. No suggestion is ready; you can choose the fields yourself. Your explanation stays in the history.';
}
