# Clarification questions ignored available transaction meaning

## Finding

The owner reported Telegram asking what an explicitly described phone top-up was
for. Inspection found the automatic queue selected the oldest unresolved outflows
without consulting classification rules or the model. AI interpretation happened
only after an owner answered. A server-side aggregate check also found **zero
category nodes for either owner**; four previous model attempts failed and one
proposed an internal transfer. The classifier schema could not name an expense
category when its vocabulary was empty. These are implementation defects, not a
reason to ask the owner to explain every payment or use a more expensive model.

## Correction

- Provision the starter category vocabulary on first production startup for owners
  with no categories. Preserve existing custom catalogs. Include mobile phone and
  internet categories. Never make a paid classifier call with an empty vocabulary.
- Run durable transaction interpretation before selecting Telegram questions:
  confirmed rules, explicit transaction signals, then the budgeted model.
- Recognize explicit phone top-ups without a paid model call. Distinguish them
  from bank/card/wallet refills, refunds and work-related/mixed expenses.
- Give the model bounded merchant-code, account-purpose and previous owner-decision
  context, without copying raw provider payloads or other transaction descriptions.
- Keep clear category suggestions in Review. Ask a specific missing-fact question
  only for ambiguous interpretations. An unavailable model or exhausted budget is
  not a reason to send generic questions to the household.
- Protect human overrides, transaction revisions, leases, replay suppression and
  the shared $10 monthly budget. No silent global rule learning.

The old automatic queue was temporarily paused server-side while this fix was
prepared. Telegram replies, reports and credential reminders remain enabled.
Automatic application of clear suggestions is a separate owner preference, asked
in the conversation and not enabled without an answer. This release improves
recognition and question selection; it does not pretend that a suggestion has
already been confirmed.

## Verification required

Synthetic examples cover multilingual phone top-ups, card/wallet refills, refunds,
work-related costs, category setup, rule conflicts, model failure/budget exhaustion,
concurrent triage, stale revisions and human overrides. Verify the live category
catalog and pure signal counts server-side without exporting bank records.

## Verified live outcome

Release 6c1de13 deployed after CI 34642814785 passed. Local/server tests: 121 passed,
two PostgreSQL-only tests run in CI. Migration 11; all 27 tables restored and compared.
Both owners now have 19 categories. The app and Telegram worker are active with the
new pre-question flow enabled. A six-record telecom check produced five Mobile phone
suggestions and one unresolved result; four suggestions meet the quiet threshold.
All six calls succeeded with measured usage. No classifications were applied.

Pure explicit-phone rules matched zero current bank descriptions: these records use
operator names plus MCC4814. This is why bank context and a live bounded check were
needed in addition to synthetic phrase tests. No raw bank descriptions or identifiers
were exported during diagnosis. Future quality improvements should use representative
synthetic regressions and explicit owner corrections rather than claim universal
accuracy from this small sample.
