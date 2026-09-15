# Editable personal-spending exclusions

Account purpose is an authoritative reporting rule, editable in **Accounts & exclusions**:

- **Business:** all transactions on this exact owner/provider/account are excluded from personal spending, unresolved personal outflows and personal pending totals.
- **Investment:** the same exclusion, with investment attribution.
- **Personal:** remove the account exclusion; existing per-payment classifications determine what counts.
- **Unreviewed:** no account exclusion is assumed; the account is visibly awaiting a purpose choice.

The rule applies to historical and future transactions for the registered account.
Changing a rule never rewrites bank amounts, categories or per-payment decisions.
The API exposes the effective classification, stored classification, account rule,
and rule revision separately. Disabling an exclusion restores the stored decision.
Newly discovered accounts require their own purpose review.

Edits show the current stored personal-expense count and exact currency totals,
require a reason for changed purpose, check the previous rule revision and record
an owner-scoped audit event. Recent rule history is visible. Read and write scope
matches the signed-in owner. Account rules take priority over individual categories;
Review explains that a stored personal category cannot override a business account.
Account changes also alter report fingerprints, leaving old snapshots immutable.

AI skips excluded accounts before paid requests and checks account purpose again
before saving an in-flight response. Excluded accounts cannot supply personal
merchant-learning examples. A vendor description containing FOP is not itself an
account rule: personal purchases from sole proprietors can still be personal.

## Owner clarification and workbook reference

The owner explicitly excluded both owners' Monobank FOP and white-card accounts.
Six current accounts were identified using provider account labels and marked
business (four Rodion, two Katya). This is account ownership/use evidence, not a
merchant-name rule. The previous bulk AI pass was paused during this change and resumed after deployment.
All 378 transactions on these accounts now receive the effective exclusion; stored
classifications are retained.

The supplied workbook contains 6,267 transaction rows and reconciles detail spending
totals to its cached 2025/2026 summary. It covers January 2025 to September 10, 2026;
the app's live annual import begins September 11, 2025. Whole-year 2025 figures are
therefore not directly comparable. Its FX method (median rates inferred from bank
operations) also differs from the current approved commercial-midpoint fallback.

The workbook is reference evidence, not a new bank import or automatic instructions.
It contains additional assumptions about large cash withdrawals and named payees;
these remain pending owner confirmation. Its transaction expense column is stored
values, so editing a category alone does not establish that the spending decision
is recalculated. Preserve the source unchanged and reconcile rather than forcing
app totals to match an approximate historical calculation. Private values and
account identifiers remain outside Git and ordinary application logs.
