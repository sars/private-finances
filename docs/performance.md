# Transaction review query batching

The review API retrieves category rules and tags for the visible transaction set
in one batch. Existing individual `suggest` and `tags` methods remain available
and are the equivalence oracle. Exact description/structured-counterparty matching,
active-rule filtering, human-classification suppression, ambiguity, tag ordering
and owner boundaries are unchanged. This optimization does not apply rules or
alter account exclusions, classification, or reporting.

The synthetic regression compares every returned suggestion and tag against the
individual methods for ten IDs, including another owner's ID, a human decision,
conflicting rules, an inactive rule, a credit and tags. Category-context SQL falls
from **28 queries to 3** for that fixture. An empty list performs zero queries.
This measures query count, not production latency; it adds no indexes or services.

Fingerprint-named JavaScript/CSS assets use private immutable browser caching.
Authentication is checked before serving assets; HTML, APIs, unversioned assets
and receipt images retain no-store. A deployment produces new asset names.

## The paged transaction list

Since September 17, 2026 `GET /api/transactions` no longer returns an owner's
whole ledger. `src/transaction-page.ts` turns every filter into a WHERE clause,
orders newest first and cuts the page with a keyset (`cursor` is the id of the
last row shown, `limit` defaults to 50 and may not exceed 200), so only the rows
on the page are enriched with account policy, spending pattern, refunds, tags,
rule suggestions, AI triage, the display conversion and historical estimates.
The response carries `total` and `nextCursor`.

The grammar is the one `/api/analytics` speaks — `owner` (absent means the
household), `from`, `to`, `category`, `pattern`, `scope`, `display` — plus what a
list needs: `review=1` for outflows still waiting for a decision, `q` for a
description fragment, `kinds`, `tag`, `receipts=with|without`,
`refunds=with|without`, `min`/`max` as minor units of `display` compared with
the magnitude of what a payment finally cost after refunds, and the household
visibility overrides `includeNonPersonal`, `includeTransfers`, `includeRefunds`
and `includeZeroAmount`.

Two predicates keep their single implementation in code rather than being
rewritten in SQL: a linked refund credit is hidden unless a link disagrees with a
later correction, and a purchase is hidden as having come to nothing only when
its net after refunds is zero without such a disagreement. Both are computed over
the few linked payments and their ids handed to SQL. The amount range needs the
reporting conversion, so when it is set the candidates are converted first and
the page cut afterwards. `test/paged-transactions.test.ts` walks every page of a
matrix of queries and requires the result to equal, in order, what the in-memory
pipeline over `repo.list()` selects.

Migration 45 adds the indexes this needs: `transactions(booked_at DESC, id)`,
`transactions(owner, booked_at DESC, id)`, a partial index for the review
predicate, `audit_events(transaction_id, created_at)` and
`receipt_jobs(transaction_id)`. `/api/review`, `/api/analytics` and
`/api/overview` still read the ledger as before; moving them is separate work.

## Remaining backend work

The batching above is a completed optimization, not a completed backend refactor.
[BE-1 through BE-3](TODO.md#1-backend-refactoring-and-measured-performance--next)
track baseline measurements, cohesive HTTP/service/data-access boundaries and
subsequent measured optimizations. Preserve contracts and financial invariants,
and report latency separately from query counts.

## Initial live API baseline

See [backend assessment](backend-assessment.md) for September 12 authenticated
read-only measurements, exact scenarios and limits. Full-year Overview payload
is 5.926 MB; optimizing read shapes is separate from choosing an HTTP framework.
