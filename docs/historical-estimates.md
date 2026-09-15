# Historical spending estimates

The historical estimate projection supports PF spending analysis without rewriting
bank records or claiming that unresolved payments were confirmed. It makes no LLM
calls and creates no future classification rules.

`estimateHistoricalSpending` evaluates a single current transaction and supplied
current evidence. The default window starts January 1 of the current year and ends
at the start of the previous calendar month, using Europe/Riga dates. Thus, during
September 2026, January–July is eligible and August remains manual review. Callers
can specify an exclusive cutoff. Transactions before 2026 always stay outside this
projection, without deleting them.

Only booked negative unresolved transactions are eligible. Account exclusions,
manual decisions (including deliberately unresolved decisions), and refund links
must be supplied by the caller and block estimates. Incoming, pending and previously
classified rows remain unchanged.

For eligible smaller payments, a current cached personal-expense proposal scoring
at least 0.70 can supply an estimate; a small whitelist of specific merchant MCCs
can supply a broad estimate without a model. Categories must exist in that owner's
current catalog. Conflicting merchant/model evidence remains for review. The model
score and fixed MCC score are heuristics, **not calibrated probabilities**.

A payment strictly greater than 3,000 UAH needs both a specific supported merchant
MCC and a matching current cached proposal to receive an estimate. Otherwise it is
high-priority review. Foreign-currency prioritization requires an exact daily UAH
conversion supplied by the existing conversion service; missing conversion remains
visible as `missing_fx`. Financial-transfer MCCs and explicit transfer/investment
context remain unresolved regardless of model confidence. Card references alone
cannot establish what a payment purchased.

Output includes status, category, method, reason, score, review priority, transaction
revision, versioned policy, current proposal ID, MCC, FX provenance and a SHA-256
fingerprint of the inputs. Recompute after any transaction revision, manual decision,
refund match, category change, evidence change or policy update. Do not serve a
stored estimate merely because its transaction ID still exists.

Integration must show estimated totals separately from confirmed spending, retain
unknown amounts and review counts, and allow users to switch estimates off. An
estimate must never enter confirmed ledger totals or the automatic-rule engine.
This module does not authorize correspondence access or implement contextual search.

Validation: TypeScript compilation and seven synthetic tests cover scope boundaries,
Riga midnight, nonmutation, large-payment prioritization, transfer safety, missing
FX, stale proposals, category removal, conflicts and fingerprint invalidation.
