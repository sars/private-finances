# Spending controls and reporting policy

The source bank amount is immutable. Category answers “what was it for?”; movement
kind answers “does it count as personal spending?”; spending pattern independently
answers “routine or exceptional?”. Expense size alone does not decide its pattern.
An expensive car repair remains Transport and can be marked Exceptional. Missing
pattern decisions stay Not reviewed; they are not silently treated as routine.

Overview keeps owner, period, currency, category, pattern and movement filters in
the URL. Charts and totals use the same filtered rows. Excluded movements remain
inspectable. Review supports an audited pattern change and refund linking;
transaction history shows what changed and why. A refund reduces what a purchase
cost without changing the bank amount or its category; the result is settled in
the account's currency and then converted like any other amount, and totals count
it. Partial and cross-currency refunds are supported. A linked credit is not
classified and not listed, so removing a link restores nothing — the credit simply
becomes unexplained incoming money again. See [refunds](refunds.md).
A refund in another month restates the original expense month; old stored report
snapshots remain immutable and a new snapshot can show the corrected result.

Currency conversion uses an immutable versioned table of daily quotes, not extra
currency columns on every transaction. Prefer transaction-specific bank amounts;
otherwise use an explicitly labeled daily commercial midpoint estimate. Never use
NBU-only quote fields. Convert each eligible transaction with exact arithmetic,
round once to the display currency's minor unit, then sum those displayed amounts.
Cross rates use exact rational arithmetic without intermediate rounding. Daily
rates use the transaction's UTC date; report calendar periods remain Europe/Riga.
The conversion list retains the same transaction IDs across display currencies;
missing rates produce a visible missing value and partial-coverage count, never zero.

Owner explanations are evidence, not blanket merchant-name rules. In particular,
July insurance-return transfers are limited to the stated recipient, amounts and
month. Card suffixes alone cannot identify a transfer destination. Full registered
account identifiers can establish own-account transfers. Investment transfers do
not enter personal spending. Runtime evidence and real bank descriptions remain
on the server, outside Git and model prompts.

Design references consulted:

- [NN/g: dashboard hierarchy and linear comparisons](https://www.nngroup.com/articles/dashboards-preattentive/): favor legible amounts, bars and trends over decorative encodings.
- [NN/g: filter behavior](https://www.nngroup.com/articles/applying-filters/): make filter scope and resulting data changes clear; preserve user context.
- [PrivatBank/LiqPay archive documentation](https://www.liqpay.ua/en/doc/api/public/archive?tab=0): commercial buy/sell fields are distinct from NBU fields.

## Private operating evidence

Runtime scoped facts: `/etc/private-finances/historical-knowledge.json` (restricted
app-readable file). Owner explanations and unmatched facts:
`/var/lib/private-finances/knowledge/owner-clarifications-2026-09-12.json` (root-only).
The runtime file is installed through a protected configuration step, then applied
with owner/revision checks through the normal classification/refund services.
Card suffixes were only used with foreign currency and bank money-transfer metadata;
no suffix-only rule was created. The insurance receipt remains unmatched rather
than being forced to balance the specified repayments.

## Daily quote freshness

The FX archive job considers today even before the first payment arrives, alongside
imported transaction dates. Its timer checks at 05:00, 11:00 and 17:00 UTC with up to
ten minutes jitter. Already-stored quote days are skipped; unpublished commercial
quotes remain unavailable and are retried on a later run. Original bank conversions
retain precedence. This does not backfill missing data with NBU quotes or silently
revise stored report snapshots. See STATUS for rollout state.
