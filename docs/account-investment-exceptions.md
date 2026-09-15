# Individual investments on a business account (PF-004)

A bond purchase made from a business card can be manually marked **Investment**
without making the card personal. Open **All my transactions**, find the payment,
open its details and choose **Investment** under the stored payment classification.
Provide a reason and save. Only the payment owner can change this decision.

The investment label remains visible in history and transaction lists. The account
still has its business exclusion: neither this investment nor its other movements
contributes to personal spending. An individual personal-expense label does not
bypass the account exclusion. Investment attribution does not infer the security,
quantity or valuation and is not a portfolio ledger.

This reuses existing per-payment classification, revision checks and audit history;
no account-wide exception or new merchant rule is created. The bank record remains
unchanged. Reimports preserve the human decision. Account purpose remains editable
and removing an exclusion restores the stored per-payment classifications.

Validation: a synthetic Katya business-card purchase is owner-scoped, audited,
preserved after bank correction, visible as Investment and absent from both native
and converted personal expense totals. Another business payment stays non-personal,
and changing the stored label to personal expense does not bypass the exclusion.
The complete spending-policy test suite also checks that excluded accounts never
consume model budget or enter personal triage.
