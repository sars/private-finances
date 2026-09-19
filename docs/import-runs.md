# Import runs: what each attempt did, and why one is waiting

## The gap this closes

Until September 19, 2026 an import left two traces and neither answered the
question anybody actually asks.

`bank_import_windows` records **coverage**: a span of days an account is known
to have been fetched for. It is written inside the transaction that commits the
payments and only then, which is exactly right for coverage and useless for
diagnosis — a bank refusing work commits nothing, so it writes no row, so it
disappeared from any list built over that table. The Imports screen's "Recent
runs" was such a list, a fixed forty rows ordered by completion, which meant the
connection most worth looking at was the one least likely to appear on it.

`bank_sync_runs` holds **one row per connection**, carrying the last state and a
single `error_code` that the next attempt overwrites. It can say that the last
import failed. It cannot say what the one before it did, what was asked of the
bank, or how many attempts have failed in a row.

And a third thing was invisible entirely. A connection that is on a cooldown
exits before it touches the bank or the database, so a bank could go a full day
between attempts while the screen showed only a stale failure — read by a person
as a fault needing their attention when it was a rest that needed nothing. In
the case that prompted this, Swedbank answered one request with a rate limit and
then sat out 132 scheduled timer firings, each of which recorded nothing
anywhere.

## What is recorded now

### `bank_sync_attempts` — one row per attempt

Written by `AttemptRecorder` (`src/import-runs.ts`), opened before the
connection is claimed and completed however the attempt ends. It carries the
connection, the window asked for, when it started and finished, the outcome, the
error code, how many accounts it reached, how many payments it wrote, and a
`steps` array.

Attempts are kept for `ATTEMPT_RETENTION_DAYS` (120) and pruned by the next
write, so the table stays bounded without a timer of its own.

Recording is strictly subordinate to importing. Every write in the recorder is
wrapped, a failure to record is swallowed, and `syncBank` takes the recorder as
an optional argument — an import must never fail because the account of it
could not be kept. `test/import-runs.test.ts` holds that against a recorder
pointed at a database that refuses every write.

### Steps: what may be kept, and what may never be

A step is a stage, an offset from the start, a duration, and whatever that
stage knows: the account (by the application's own identifier), a request path,
an HTTP status, the size in bytes of what came back, a count, an error code, and
the wait a bank asked for.

Every request is reported, not only the refused ones. The first version of this
reported failures alone, which made a healthy run look as though it had asked
the bank for nothing at all — caught on the first real import after release,
because the production step log held stages and no requests. A request that
never produced a response at all (a timeout, a refused socket) is reported with
no status, and is the failure most worth seeing, since nothing else records it.

A step must **never** carry a payload, an amount, a description, a merchant, a
counterparty, a token, a session identifier or a provider account id. Enable
Banking addresses both the consent session and the provider account id in the
path — `/sessions/{id}`, `/accounts/{uid}/transactions` — so no path is stored
as given. `sanitizePath` reduces one to its shape, keeping only segments this
application wrote as literals and replacing everything else with `…`, and
dropping the query string. It is the only way a path enters a step.

### `bank_sync_runs.retry_after` and `retry_reason`

The scheduler holds the cooldown in a file under `/var/lib/private-finances-sync`,
which the web process deliberately does not read. It now also announces the
next-attempt time and its reason to the database, through the `announce`
callback on `runScheduledSync`. The reason is one of `rate_limit`, `transient`,
`polling_interval` or `blocked`, kept in `<instance>.retry-reason` beside the
time so a restart does not lose it.

It is re-announced on **every** deferral rather than only when the cooldown is
set, which means a wait begun by a release that predates this record still
reaches the screen (with a null reason, which is honest — the time is the part
being waited for), and a cooldown cleared by hand on the server stops claiming a
bank is asleep.

Announcing is diagnostic. A failure to announce is swallowed and never changes
what the scheduler decides; a test holds that too.

## Where it shows

| Screen               | What it answers                                                  |
| -------------------- | ---------------------------------------------------------------- |
| `/imports`           | Is each connection healthy, and when does a resting one resume   |
| `/imports/runs`      | What has been happening, filtered by bank, outcome and period    |
| `/imports/runs/{id}` | What one attempt asked for, what came back, where it stopped     |
| `/ops`               | A bank silent for over 25 hours, now with the hour it next tries |

`/api/import-runs` pages with a keyset (`started_at`, `id`) rather than an
offset, for the reason the payments list does: a table being appended to while
it is read must not show a row twice or drop one between pages. Filters are
validated in `parseRunQuery` and reach SQL only as bound parameters.

A bank resting on a cooldown is a **warning** on the problems list rather than a
critical one: nothing the owner does will speed it up, and the entry still says
the totals are short a bank until it catches up. Its link stays on Bank
connections, because the problems list links to where a fix is, not to where the
symptom shows.

## Looking at the screens

`scripts/seed-demo-runs.mjs` puts a few dozen attempts into the demo database,
including a bank stuck on a rate limit, so the two screens can be rendered and
looked at:

```
node scripts/seed-demo-runs.mjs
pnpm demo
pnpm shots /imports/runs /imports
```

Development only. It never runs on the server.
