# Перевірки й Definition of Done

## Зараз

`python3 scripts/check_repository.py` і `git diff --check` перевіряють foundation.
CI запускається на GitHub: початковий main і PR #1 (affb7e5) пройшли Foundation checks
2026-09-11. Це перевірка foundation; тестів продукту ще немає.

## Перед першим merge коду продукту

Додати єдину команду check: format → lint → typecheck → unit/integration → build.
Використовувати frozen lockfile і точну runtime version. Tests не потребують
реальних банківських ключів; synthetic fixtures зберігаються в repo.
Integration DB тимчасова на job; міграції перевіряються від нуля й від попереднього
релізу з synthetic даними. Production credentials у CI не використовуються.

## Найважливіші сценарії

- Повторний import, перекриті date windows, pagination і late correction.
- Crash після збереження транзакції до checkpoint; повтор без дублювання.
- Два workers борються за job; лише один власник, lease recovery без крадіжки живої job.
- Pending→booked із зміненим provider ID; правила злиття provider-specific.
- Валютний transfer: дві суми, різні валюти, fee окремо, match може бути uncertain.
- Refund, split, income перевіряються після бізнес-рішення, не вигадуються тестом.
- FX відсутній, межа місяця, DST, inclusive/exclusive period boundaries.
- Повторний Telegram update; відповідь не тому owner; stale clarification.
- LLM invalid JSON, prompt injection в description, timeout, budget exhausted.
- Worker живий, але останній import застарілий: degraded, а не healthy.
- Dashboard без доступу; drill-down дорівнює агрегату; mixed owners не губляться.

## Готовність зміни

Вимога прив'язана до тесту; релевантні gates пройдені; review виконаний;
міграція має compatibility/backup plan; документація актуальна; commit/PR містить
доказ і відомі обмеження. Coverage percentage не заміняє перевірки цих сценаріїв.
Окремо від merge: deployment done лише після smoke, readiness і перевірки worker.

## Running the suite

`pnpm test` compiles the backend with `tsc` and runs every test file with
`--test-concurrency=2`. It deliberately skips the frontend typecheck and the Vite
bundle: no test reads `dist/frontend`, because the two that exercise frontend
helpers import the TypeScript source directly through Node's type stripping, and
`scripts/test_frontend_assets.py` builds its own fixture tree in a temporary
directory. Dropping that dead work saves about 13 seconds of every test run.
`pnpm check` still runs `pnpm build:frontend` afterwards, so the frontend is
typechecked and bundled before a change is considered ready — it is simply no
longer paid for on each inner-loop `pnpm test`. Measured on
an 8-core machine, 2 is the fastest setting: each test file boots its own PGlite
engines, so 4, 6 and 8 parallel files are progressively slower, not faster.
`pnpm test:progress` is the same run with `--test-reporter=spec`, for watching test
names scroll by when the output is piped or logged instead of shown in a terminal.

Under `node --test`, `migrate` restores a throwaway in-memory database from a
snapshot of a migrated database instead of replaying every version block
(`src/database.ts`). Booting PGlite is what costs: 2,953ms to boot and migrate
against 735ms to restore. The snapshot is cached in `dist/.pglite-cache`, which
matters because `node --test` runs each test file in its own process — 57 of the
82 files need a database, and without a cache on disk every one of them pays for
its own initdb, about 27% of the suite's total CPU. The cache is keyed by a hash
of the compiled sources under `dist/src`, so a build that changes a migration
produces a different key and the snapshot is rebuilt rather than trusted. It is
written atomically, because test files run concurrently and can race to fill an
empty cache, and any failure to read or write it falls back to a real migration.
A restore is a new PGlite engine with its own
storage, so databases stay independent; `test/database-snapshot.test.ts` pins both
that isolation and the fact that an already-used database is still migrated by the
real migration code. PostgreSQL and the on-disk demo database never take this path.
