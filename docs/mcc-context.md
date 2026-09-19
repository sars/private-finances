# Merchant category context (PF categorization)

MCC is supporting bank evidence, not a description of the purchased item. The
display lookup covers common retail, transport, utilities, personal services, health,
education and government codes, including department stores (5311). Unlisted codes
explicitly display “Unknown merchant category” alongside the number. Display labels
do not expand the codes eligible for automatic classification.
Both Monobank numeric codes and Enable Banking four-digit codes are understood.

Source: [Visa Merchant Data Standards Manual, April 2026](https://usa.visa.com/dam/VCOM/download/merchants/visa-merchant-data-standards-manual.pdf).

Transaction details display code and meaning. AI receives the same bounded meaning
and an explicit inference caution. MCC 4829 prevents model/model-cache decisions
from automatically becoming personal expenses even at high confidence. It does
not itself prove an own-account transfer, investment or income. Explicit confirmed
owner rules retain priority; direction and account-purpose exclusions still apply.

This does not retroactively rewrite existing classifications or make additional
paid requests. Synthetic tests cover both providers, malformed/unknown codes,
model context, and prevention of high-confidence transfer misclassification.

Policy v4 normalizes either provider's MCC before eligibility checks and cache
signatures. A stored model proposal at confidence 0.70 or above can be applied
only when its broad category agrees with a supported code: Food / Groceries with
5411 or 5499, Food / Restaurants with 5812 or 5814, or Pets with 5995. Existing
contradiction, account-purpose, direction and human-decision protections remain.
Other supported consumer decisions retain their previous confidence requirements.

The policy also rejects model-only Transport interpretations of software-store
MCC 5734 and specific AI/code-tool interpretations of generic digital-goods MCC 5818. MCC 8398 gains a charity label, but does not independently authorize a
donation classification. Owner-confirmed rules can resolve these contexts.

Ready proposals are reconsidered once per policy version without another paid
request. The pure `sufficientAutomaticConfidence` export lets the private golden
reference compare eligibility without modifying transactions. This is a policy
eligibility check, not a substitute for end-to-end ledger and owner-scope checks.
Pets and Donations are now available in the idempotent starter category set.
