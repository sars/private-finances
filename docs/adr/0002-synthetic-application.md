# ADR 0002: Runnable synthetic application

Date: 2026-09-11. Status: accepted for the first development slice.

## Runtime and persistence

Node 24, TypeScript strict, pnpm with exact dependencies and a committed lockfile.
One package with domain, repository, HTTP and worker modules; split into workspaces
only when independent builds justify it. No frontend framework is necessary for this
first transaction/classification flow. Server-rendered HTML works without JavaScript.

Production storage target remains PostgreSQL. SQL is parameterized through `pg`.
Local synthetic mode uses PGlite, an embedded PostgreSQL runtime, to work without
bank credentials or a local database server. Its data directory is ignored by Git.
PGlite is single-process demo storage, not a substitute for production PostgreSQL.
CI also runs migration and concurrent import checks against PostgreSQL 16.

Schema version 1 is applied transactionally under a migration advisory lock.
Imports serialize under a separate advisory lock. A batch, source audit events,
job completion and sync watermark commit together. Replays do not duplicate entries.
Source corrections increment the row revision but preserve human classification.
Manual edits use optimistic revision checks and record before/after values and actor.

## Worker

The first worker runs in the web process and only imports a fixed synthetic fixture.
Jobs are durable and claimed with a lease and SKIP LOCKED. Expired claims are retried
up to three attempts; live claims are not recovered. The import transaction locks
the job row, so a recovery process cannot reclaim an active import transaction.
This bounded local workload does not need a separate heartbeat timer. Real network
connectors will need heartbeat renewal, request deadlines and connector-specific
failure classification before being enabled. No real bank import endpoint exists yet.

## Interface and access

A dark, table-first working surface: owner filter, per-currency confirmed totals,
unresolved outflows, inline classification and a system-health page. No invented
exchange rates. Money never passes through floating point. Current display formatting
is limited to UAH/EUR; other currencies explicitly show minor units.

Demo mode permits switching the acting owner only for synthetic transactions.
PostgreSQL mode requires separate owner passwords and checks ownership on writes;
both household members may read combined data. The listener is loopback-only and
checks Host to resist DNS rebinding. Forms require a random anti-CSRF token.
Production deployment still needs TLS through the private access layer, verification
of allowed identities, rate limiting, secret provisioning, backups and restore tests.
Never expose this development listener directly to the Internet.

UI references checked before implementation:

- https://carbondesignsystem.com/components/data-table/usage/ — action/filter placement.
- https://www.w3.org/WAI/tutorials/tables/ — captions and column header semantics.

## Read-only VPS inventory

2026-09-11: Linux x86_64; Node 24.15.0; psql installed; approximately 7.8 GiB RAM,
3.2 GiB available, 4 GiB swap, 58 GiB disk free at inspection time. No services,
database roles, packages or configurations were changed. Local/CI Node is pinned
to 24.19.0; align the isolated deployment runtime before release without upgrading
the shared host as a side effect.

## Limitations

This proves the synthetic flow, not F1/F2 completion. Historical FX, hierarchical
categories, source/session onboarding, transaction details/audit UI, date filtering,
Telegram, LLM, reports, production monitoring alerts and deployment remain pending.
The `/ops` page covers DB readiness, import freshness and job states; it does not
yet claim disk, backup or worker-heartbeat monitoring.
