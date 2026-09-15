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
