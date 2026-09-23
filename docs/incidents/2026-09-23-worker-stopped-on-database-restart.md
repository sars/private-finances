# 2026-09-23: the worker stopped when PostgreSQL restarted

Status / severity / affected release: closed / medium / 02304dd.
Impact: no data changed or lost. `private-finances-telegram.service` was down
from 03:38 UTC until the next release: no triage, no Telegram questions, no
receipt or refund passes. A payment booked that day stayed unresolved with no
question sent. The dashboard stayed up.
Start, detection, recovery (UTC): 03:38:53 crash; found about twelve hours later
while explaining why a payment in Review had no Telegram question; recovered by
the release carrying the fix.
Evidence: `systemctl` showed `failed`; journal: unhandled `'error'` event on a pg
client, `code: '57P01'` (terminating connection due to administrator command),
seconds after `apt-daily-upgrade` started.
Cause: the nightly unattended upgrade restarted PostgreSQL. The worker polls
every second, so its pool always held an idle connection; the server ended it,
the pool emitted `'error'` with no listener, and Node exited. The unit had
`Restart=no`, an open question since the 14 September incident, so it stayed
down. The Problems block did not notice: it watches undelivered messages, and a
stopped worker queues none.
Recovery and integrity check: after the release the service is active and the
day's payment is triaged.
Regression test / PR: `test/database-connection-lost.test.ts` terminates the
pool's idle backend on real PostgreSQL (CI) and requires no uncaught exception
and a working next query.
What changes: the pool logs `database_connection_lost` and carries on; the unit
restarts on failure after 30 s, at most five times in ten minutes; `release.sh`
now installs changed unit files, which previously reached the server only by
hand. Not done: a heartbeat so a worker that stays down shows up on Home.
