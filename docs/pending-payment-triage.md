# Categorization while the bank is processing a payment

Pending outflows enter ordinary triage after import, using the same confirmed
rules, merchant/MCC checks, model thresholds and shared $10 monthly cost guard as
booked payments. Pending bank status is not uncertainty about what was purchased.
Business/investment account exclusions, human decisions, refunds and transfer
safeguards retain priority. This does not authorize automatic incoming-money
classification or change any bank status, amount or reporting calculation.

Live Telegram questions may include pending outflows after their normal triage
attempt, only at or after `TELEGRAM_LIVE_QUESTIONS_FROM`. The previous daily/backlog
lane remains booked-only. Prompts and reply proposals label these payments
“Bank processing” and explain that the amount can change. Owners can reply and
confirm a category while the payment remains pending.

**Pending amounts are counted as spending** (15 September 2026). They used to be
held out of every total as money that had not finally left. That is false for
Monobank: the money is deducted at authorisation, the balance in the bank's own
payload runs straight through these rows, and asked again four months later the
bank still answers `hold: true` for the same operations — the flag marks an
amount that could still be adjusted, not money still in the account. The
scheduled sync also only asks for the last 31 days, so an older hold is never
re-read and could not change status on its own. Ninety-nine outflows had sat
uncounted and uncategorised for up to a year.

So a hold now enters the totals, the monthly chart and the resting place like
any other payment. The pending figure is still reported everywhere it was, but
it now means "of which the amount is not final" rather than "as well as". The
machinery that waits for settlement is unchanged and still correct for a hold
that really is revised: refund links made against one are marked provisional and
re-checked, and a receipt stranded on a hold moves to the settled row if one
appears. Enable Banking's pending mapping is untouched — no Wise or Revolut
payment has ever arrived as pending, so there is no evidence either way.

A new nullable `telegram_outbox.payment_snapshot` column preserves the private
payment context of new questions. An unresolved payment settling from pending to
booked can reuse its existing question and accept a reply to that question when
owner, account, source, date, amount, currency, description and provider evidence
are otherwise identical. The only provider-evidence exception is Monobank's exact
`hold: true` to `hold: false` transition. No general metadata is ignored. Monetary,
merchant, date or other evidence changes remain stale; human decisions are never
rebased. Legacy questions without snapshots retain strict revision checks. A
payment resting provisionally still has a live question, because a provisional
placement is where the evidence pointed and not a decision; only a person's
decision retires one.

## A settling hold is not the bank correcting itself

The same test decides whether a re-import may discard an automatic
classification, and one function — `isSettlementOnly` in `src/domain.ts` — now
answers it for both the importer and the question rebase, so the two can never
drift apart.

The importer used to compare the whole row, so `status` moving from pending to
booked and `hold` from true to false counted as the bank correcting the evidence
its classification had been built on. It discarded the classification and the
payment fell back to whatever its merchant code alone implied, marked
provisional, arriving in the owner's review queue as though nothing had ever
decided it. That is what happened to a Rimi shop the model had placed at 0.96
confidence and an H&M purchase an owner-confirmed rule had placed at 1.0.

Every one of the thirty re-imports in the ledger's history was a settlement of
this kind: not once had an amount, a currency, a description, a date or a
merchant category actually moved. The rule had never caught a real provider
correction and had only ever destroyed correct answers.

A settlement is now recorded as its own audit event, `settled`, and leaves the
classification standing. The test stays strict in the other direction: anything
else that moves, including a key that was not there before, is `source_corrected`
and still invalidates an automatic decision. Migration 42 restores the decisions
already lost, reading each one out of the audit trail that recorded it, and only
where no person has decided the payment since and no later automatic pass has
already answered it.

Migration 16 adds the column for existing databases as well as fresh installs.
The migration is additive and initializes idempotently; old binaries tolerate the
new nullable column. Include it in backups and restore comparisons. Do not erase
snapshot/evidence or outbox history on rollback. Snapshots stay in the private
server database and are not sent to Telegram, models or operational logs.

An automatic model attempt with failed or still-reserved state is not retried
merely because settlement produced a new revision. A human clarification or a new
receipt has its own request key and may supply new evidence under the existing
cost limits. Stale proposals and changed financial evidence still require a fresh,
valid decision; this change does not silently confirm them.

## Settlement refresh

Monobank statement imports already replay the last 31 days, including pending
payments. They run 30 minutes after the previous import completes (currently about
37–38 minutes between starts). A later `hold: false` updates the existing payment
to booked; requesting data cannot force settlement. The API record gives no
completion deadline. Categorization and receipt processing do not wait for it.

## A decision that cannot be written is a question, not a silence

Triage finishes a payment in one of four states, and `ready` is the one that
means *decided, nothing to ask*. Until 20 September 2026 it could also mean
*decided, and nothing written*: the automatic write refuses to file a payment
under a catch-all leaf, so a decision whose category was `Unspecified` was
stored as `ready`, applied to nothing, and carried no question text. The
question lane only ever selects `ready` rows that carry their own question, or
rows that are `deferred` or `uncertain`, so such a payment was invisible to it.
It was neither classified nor asked about, and nothing would look at it again.

The two halves now share one test — a category whose leaf is `Unspecified` — so
they cannot drift apart. A decision the write would refuse finishes `uncertain`
instead, and the member is asked. `ready` means the decision was written.

A second route to the same silence ran through confidence rather than category.
Whether to ask kept its own threshold, 0.9, while the write kept another: 0.95,
or 0.9 with the bank's merchant code corroborating it, and never where a signal
contradicts the decision. A model decision between the two thresholds, or one at
any confidence carrying a contradictory signal, was stored `ready` with no
question text and then not written. Asking now consults the write's own test
instead of a number of its own. The 0.9 floor stays, so the change only ever
adds a question and never removes one.

One case is left deliberately. When `AUTO_CATEGORIZE_CLEAR_EXPENSES` is off no
decision is written at all, and a decision that would otherwise have been filed
stays `ready` without a question. That is the setting's meaning rather than a
fault: with automatic categorization off, a clear payment waits in the review
queue instead of becoming a message. Turning those into questions would make
switching the setting off send more Telegram messages than leaving it on.

### How a confirmed rule came to have no category

The route in was the category-tree migration. It moved every confirmed rule's
category onto the shared tree through an explicit map of legacy paths and sent
anything unlisted to the root catch-all; payments got a fallback pass first,
rules never did. The household's legacy "Shopping" branch was deliberately
unmapped — naming a shop says nothing about the purpose — so fifty-eight
owner-confirmed rules survived it still matching, still confirmed, and pointing
at Unspecified. Every payment matching one of them went silent.

Migration 63 repairs them from the only source that still exists: the
household's own decisions. Where a member has filed the same merchant under one
leaf themselves, that leaf is restored and the rule stays active. Where they
have filed it under several, never filed it at all, or where the owner has said
the shop's name settles nothing — a variety chemist sells cosmetics and cleaning
liquid across one counter — the rule is retired and the payment goes back to
being asked about. Each change is a new edition of the rule with its reason in
`classification_rule_audit`, and the payments already stranded are moved to
`uncertain` so they are asked rather than left.
