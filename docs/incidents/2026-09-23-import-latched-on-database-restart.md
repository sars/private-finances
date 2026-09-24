# 2026-09-23: a database restart stopped Kate's Monobank for a day

Status / severity / affected release: closed, fixed in 6d613a1 / medium /
02304dd and 1a4e0c1.
Impact: no data changed or lost. `monobank:katya` imported nothing from 03:04 UTC
on 23 September; every half-hourly firing afterwards exited `blocked` without a
request to the bank. The other six connections were unaffected.
Start, detection, recovery (UTC): 03:38:53 the import died; noticed by the owner
on 24 September, about 27 hours later, from Kate's missing payments.
Evidence: journal: `apt-daily-upgrade` started 03:38:33 and restarted
`postgresql@16-main` at 03:38:53, the same second the import exited; the scheduler
logged `blocked` on every firing since. `bank_sync_runs` still said `running`
with a lease that expired at 03:43; the newest `bank_sync_attempts` row was
`running` with no steps and no finish.
Cause: the same PostgreSQL restart as
[the worker incident](2026-09-23-worker-stopped-on-database-restart.md), four
minutes into a seven-minute Monobank import. The import's failure was reported
as `configuration_or_sync_error`, which the scheduler treats as unknown and
latches for a person — correct for a bank that refused something, wrong for a
database that was gone for four seconds. Since release 170fc05 the pool also
writes a `database_connection_lost` line to stderr first, and the scheduler
parsed stderr as a single JSON document, so every such failure would have read
as unknown even with a right code.
Why nobody saw it: the Bank imports page showed "Importing now" for any
`running` row, lease or not; the Problems list ignored the scheduler's `blocked`
announcement and waited for the 25-hour silence rule; System health listed no
imports at all; nothing was sent to Telegram.
Recovery: the release carrying the fix lifts the latch itself — the stuck
attempt is the evidence — and imports on the next firing.
Regression tests: `test/sync-failure.test.ts`, `test/schedule-interrupted.test.ts`,
`test/stopped-imports.test.ts`.
What changes: a lost database connection is reported as `transient`; the
scheduler reads the last `bank_sync_failed` line; a latch whose run left its
attempt open with no live lease ten minutes on is lifted on the transient
backoff (1 h, 3 h, 24 h, from when that run began); a `running` row with a dead
lease reads as stopped; a latched connection is a Problem at once; System health
shows the Problems list; a connection stopped for three hours or more is sent to
Telegram once per stop through the reminder outbox (migration 67).
Left alone: the unattended upgrade itself. The server also runs other
applications, and this one has to survive a database restart anyway.
