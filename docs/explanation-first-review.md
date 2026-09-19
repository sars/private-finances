# Explanation-first review and cash entry

The owner requested a dedicated review page on September 12, 2026. Payment selection
continues to live in the URL, preserving list filters and browser Back/Forward.
Review is a sustained task: show payment/receipt evidence and saved explanations,
then a prominent plain-text explanation field, then editable suggested fields and
explicit confirmation. Manual editing remains available. Explanations are evidence;
a model suggestion never silently replaces a confirmed decision.

The application saves owner text before optional AI, including when configuration,
budget or a model request fails. Retrying the same submission cannot create another
input or model request. New wording is a new explicit submission. The same owner-
scoped history combines Telegram and app explanations with source labels and times.
Entering a payment refreshes its details while retaining available cached content;
there is no live polling. Explanations appear before the long list of bank fields.

Cash entry asks for amount and description, with editable date and currency. Owner
is the authenticated person; today uses Riga and currency defaults to the selected
display currency. The original description is saved as app context and can produce
an editable suggestion before the owner confirms. The bank/accounting pipeline
receives an ordinary booked, initially unresolved manual_cash record, so confirmed
cash spending participates in the same totals and FX conversion. Amounts remain
exact minor units. See cash-transactions.md for deduplication and date precision.

A bank withdrawal funds cash; it is not a second purchase. Existing withdrawals
are not automatically rewritten or matched. Reconciliation of previously classified
withdrawals remains separate. Cash entries and current app explanation drafts stay
out of automatic question/classification workers while their owner reviews them.
Receipt attachment remains available; auto classification cannot race that draft.

UX references reviewed for this increment:

- [NN/g: bottom sheets](https://www.nngroup.com/articles/bottom-sheet/) — overlays
  support short interactions rather than complex evidence review.
- [shadcn Field](https://ui.shadcn.com/docs/components/base/field) — semantic grouped
  labels, descriptions and consistent spacing. Use current component primitives;
  no new form library is required for these small forms.

Release/testing status is maintained in STATUS; a written design is not a claim
that the deployed app has changed.
