# Backend architecture, stack and initial performance assessment

September 12, 2026. Requested assessment, not an approved stack migration. No
application code, dependencies, financial records or deployment changed.

## Recommendation

Keep TypeScript, Node.js and PostgreSQL, the existing financial domain logic and
separate background workers. Refactor as a modular monolith: one application with
clear feature/service boundaries. Prefer Fastify for the future HTTP layer, adopted
one endpoint group at a time after documenting contracts. First reduce repeated
work and response sizes; framework replacement alone will not solve these issues.
Retain `pg` and explicit SQL initially. Consider Kysely separately if typed query
construction materially improves the new read repositories; no ORM migration is
required for performance. No new database, Redis, microservices or runtime selected.

## Current state

- Node 24 target with TypeScript; native `node:http`, a handwritten router and
  hand-written validation/response composition. React/Vite remains the frontend.
- PostgreSQL production via `pg`; PGlite for local/demo/test use. Live server reports
  PostgreSQL 16.15. Explicit SQL, transactions, locks, revisions and financial audit.
- Existing services cover accounts, imports, classification, receipts, explanations,
  FX, reports, Telegram and budgeting. This is not an empty architecture.
- `src/web.ts` is 1,212 lines combining HTTP concerns, service orchestration, queries,
  response assembly and older HTML views. Those responsibilities need separation.
- Separate systemd app/import/Telegram/report processes on the same private VPS;
  Tailscale HTTPS; PostgreSQL-backed job/lease state. Bank synchronization already
  runs separately from normal dashboard reads.
- Pool maximum is five per process, not five across all workers. Do not increase
  blindly: inspect aggregate connections and waiting first.

## Measured initial baseline

Authenticated read-only GET requests from the VPS to localhost, three sequential
samples per route, current live release 7386d2b. Times include server execution and
local HTTP/body reading; exclude browser rendering and the user's internet route.
Decimal MB below; no payload content was logged. These are samples, not p95, a load
benchmark or precise CPU/SQL attribution. Each scenario's exact filters are below.

| API scenario | Observed range | JSON response size |
| --- | --- | --- |
| Bootstrap | 0.9–28.3 ms | 347 bytes |
| Overview, household Sep 1–12, UAH | 147–269 ms | 0.197 MB |
| Overview, household Jan 1–Sep 12, EUR | 492–572 ms | 5.926 MB |
| Review default | 222–235 ms | 0.993 MB |
| Review all history, EUR | 332–372 ms | 3.412 MB |
| FX household Jan 1–Sep 12, EUR | 299–341 ms | 3.538 MB |
| Receipts | 3.7–6.7 ms | 1,789 bytes |
| Accounts | 75–79 ms | 7,508 bytes |
| Operations | 9–11 ms | 2,921 bytes |

Exact scenarios: `/api/overview?display=UAH&from=2026-09-01&to=2026-09-12`,
`/api/overview?display=EUR&from=2026-01-01&to=2026-09-12`, `/api/review`,
`/api/review?all=1&window=all&display=EUR`, and
`/api/fx?display=EUR&from=2026-01-01&to=2026-09-12`. Household Overview/FX omit owner;
review retains the authenticated owner's scope. Initial `owner=all` probes were
rejected and excluded; the corrected requests use the existing API contract.

The localhost requests did not advertise compression and received no Content-Encoding.
This is JSON body size, not proof of browser wire size through Tailscale. Native
JSON responses currently do not implement compression. Inspect actual browser
transfer encoding before selecting compression changes.

One unauthenticated Mac → Tailscale bootstrap request returned 401 in 87 ms
(TCP 52 ms, TLS complete at 75 ms). This only establishes an accessible private
path at that moment, not mobile latency, throughput, authenticated page timing or
whether the user's phone has a direct/relayed connection.

Capacity snapshot: 3,894 transactions; whole database about 25.6 MB; two CPU cores,
about 8 GB RAM with 4.8 GB available; load average about 0.6. Swap is in use, but a
snapshot cannot determine current swapping or host contention. No capacity upgrade
is justified by this snapshot alone. Other applications share this server.

A separate function-stage probe failed PostgreSQL authentication (28000), including
under the service OS identity. No stage timings were obtained; no authentication
configuration was changed. SQL/pool/CPU attribution remains open. HTTP measurements
above succeeded independently.

## Why pages can feel slow

Visible loading depends on API work + network/request sequencing + response transfer
+ JSON processing + client rendering. Some stages overlap. Fast local receipt API
timing means receipt-page delays need client/network investigation too.

Code-confirmed inefficient patterns (impact not individually profiled yet):

1. **Overfetching.** Overview returns ledger rows plus conversion rows, converted
   lists and historical projections. Analytics should request summaries and chart
   buckets, then fetch matching transactions on drill-down. A full-year chart should
   not require a six-megabyte ledger response.
2. **Full-ledger reads.** `Repository.list` selects `t.*` and enriches all returned
   rows; route/date filters are applied afterward. `detailOnly` review still reads
   the owner's ledger and owner-wide workflow history before restricting the result.
3. **Repeated computation.** `historical-reporting.ts` joins arrays with repeated
   `.find`, and it plus `historical-estimates.ts` constructs date formatters and
   recomputes the historical window repeatedly per payment. `fx-rates.ts` scans the
   loaded quote range per conversion. Reuse formatters and request-local maps/quote
   indexes while preserving date, rounding and source/version rules.
4. **Broad sequential API assembly.** Review computes conversions, estimates,
   triage, proposals and explanation history before returning. Split list/detail/
   replies into bounded read contracts; parallelize independent reads cautiously.
5. **Client waterfalls.** Some screens still fetch after mounting and after bootstrap;
   detail evidence then starts further requests. Remaining Query migration matters
   even after backend fixes. No routine reload or live polling is required.
6. **Insufficient attribution.** Existing request logs have total duration and request
   ID but need safe route labels, stage/query timing, pool wait, event-loop delay and
   response bytes. No transaction descriptions, credentials or raw querystrings.

Node's event loop makes synchronous CPU-heavy work relevant to other requests;
framework changes do not remove it. See [Node guidance](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop).

## Stack options and tradeoffs

Modern fit here means typed contracts, validation, observable behavior, testability
and support for the existing deployment. It does not mean the youngest framework.
No popularity/growth ranking or framework benchmark is asserted.

| Option | Advantages | Costs and fit for this application |
| --- | --- | --- |
| Native Node HTTP, refactored | No migration/dependency cost; existing behavior | We continue maintaining routing, validation and response conventions ourselves. Valid short-term optimization path. |
| **Fastify + TypeScript** | Schema-based request validation/response serialization; encapsulated plugins for modules; stays on current runtime | Schema and route migration effort; auth/CSRF/error/receipt/consent contracts need regression checks. Best balance for this app. |
| NestJS with Fastify | Prescribed modules, dependency injection, guards and framework conventions | More abstraction and ceremony; reasonable for larger multi-developer backends, unnecessary overhead for current team/size in my assessment. |
| Hono | Small Web-Standards API, portable across runtimes | Attractive for edge/multi-runtime deployment; those are not current needs, and service/schema conventions still need design. |
| Python FastAPI | Typed validation/OpenAPI and a natural Python analytics ecosystem | Rewrites working TypeScript financial/integration logic and creates a second language boundary. Current LLM work calls APIs; Python is not required. |

Official references reviewed:
[Fastify schemas](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/),
[Fastify module encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/),
[Nest adapter](https://docs.nestjs.com/techniques/performance),
[Hono](https://hono.dev/docs), [FastAPI](https://fastapi.tiangolo.com/features/).
These establish capabilities, not expected speedups on this app.

Database choice: retain PostgreSQL. Relational accounts/transactions, exact amounts,
constraints, revision history and transactional updates fit it well. First inspect
[query plans](https://www.postgresql.org/docs/current/using-explain.html) and
[aggregate pool sizing](https://node-postgres.com/guides/pool-sizing).
For type-safe queries, [Kysely](https://kysely.dev/) is close to explicit SQL;
[Drizzle](https://orm.drizzle.team/docs/overview) additionally offers schema/ORM tooling.
Either needs schema/type and money/date mapping validation; neither automatically
fixes bad query shapes. Keep existing migrations and SQL initially; review typed
query tooling separately after one representative repository prototype.

## Proposed structure

```text
HTTP routes + validated request/response schemas
    → application use cases / purpose-specific read services
        → existing financial policies and exact-money functions
        → focused PostgreSQL repositories
Bank / Telegram / LLM / receipt-storage adapters
    → background jobs using the same application services
```

Organize modules by feature (transactions/review, reporting/FX, receipts,
connections, settings/operations), with clear HTTP/service/repository boundaries
inside each. Keep deployment as one application plus workers. Bank/AI calls must
not enter ordinary list/dashboard reads. Calculation results are derived; original
bank records, actual-conversion precedence and manual decisions remain authoritative.

## Proposed atomic sequence

1. Finish baseline instrumentation and browser waterfall measurement; establish
   response-size/latency budgets for exact representative scenarios.
2. Correct obvious request-local computation waste, with equivalence tests on money,
   FX provenance, Riga calendar boundaries, uncertain and excluded payments.
3. Add lean dashboard aggregates, filtered/paged transaction lists and exact detail
   reads. Preserve drill-down totals, authorization and stable pagination; migrate
   consumers incrementally rather than silently changing existing API contracts.
4. Extract feature/service boundaries; trial Fastify on one small endpoint group,
   then migrate after contract/permission/error tests. Framework recommendation
   remains proposed until the owner chooses it.
5. Complete client cache/request scheduling and measured SQL/index changes.
   Reassess compression after reducing data; add derived caching only if still
   justified, with explicit invalidation and freshness. No Redis by default.

Proposed initial budgets, not promises or measured results: ordinary list/detail
and dashboard-summary server responses under 150 ms in representative warm tests,
initial list JSON under 100 KB and summary JSON under 50 KB. Agree reference device/
network before setting end-to-end page targets; document p50/p95 over a sufficient
sample and safe low concurrency. No financial regression may be traded for speed.

No package installation, refactor or deployment is authorized by this assessment
alone; existing approval for general work does not substitute for the requested
stack discussion first. Next decision is whether to adopt Fastify incrementally
while retaining the runtime/database and optimizing the current data paths first.
