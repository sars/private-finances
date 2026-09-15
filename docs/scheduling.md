# Provider-aware recurring imports (PF-002)

Live pilots and local recovery are verified. See STATUS.md for enabled instances. The scheduler is a separate Node entry point calling
the existing server-only sync CLI; it does not change bank authorization.

Each run replays a rolling **31-day window ending now**, including today's
partial day. Existing idempotent imports reconcile pending records and corrections;
a successful run is not proof of complete history or settlement. Outages longer
than 31 days require explicit backfill. Reporting still uses Europe/Riga periods.

Monobank polls **30 minutes after the previous run finishes**, plus up to 60 seconds
jitter. Sequential requests retain the 60-second per-token spacing. The actual
refresh interval includes the time needed to fetch all accounts.
Wise/Revolut through Enable Banking default to **six hours after completion**.
The current owner-authorized trial uses **30 minutes after completion** for Rodion
Wise/Revolut and Katya Wise, with a sticky six-hour fallback after API errors (see
trial section below). Persisted success cooldowns prevent early repeats after
timer/server restarts.
This is a conservative background policy, not a verified bank-specific maximum:
[Enable Banking FAQ](https://enablebanking.com/docs/faq/) notes many banks allow only
four background fetches/day. Never send fabricated online-user PSU headers.
[Monobank personal API](https://api.monobank.ua/docs/index.html) documents the
60-second statement/client-info limits. Both sources checked September 12, 2026.

Timers start once after boot and do not replay every missed interval. Each firing
makes one bounded attempt. Existing transient/rate-limit errors retain a 24-hour
cooldown; auth/uncertain failures stay latched for investigation. The app retains
connection leases and never overlaps the same scheduled instance.

Install the Monobank owner-specific timer drop-ins alongside the timer template.
Each run still requires a fresh local backup. Retention keeps 14 recent snapshots
plus one per day for the latest 14 snapshot days (at most 28 files), so faster sync
cannot replace the entire daily recovery history in a few hours.

## Gates before enablement

Install the service/timer templates under `/etc/systemd/system/` after reviewing
them against the server layout. Build the release first. The service needs the
existing restricted `app.env` and an additional restricted
`/etc/private-finances/sync.env` supplying `CREDENTIALS_DIRECTORY` and, for Enable
Banking, `ENABLEBANKING_APPLICATION_ID`. Credentials remain outside releases/Git.
The /etc/private-finances parent must allow service-user traversal (for example
root:private-finances mode 750); app.env remains root-only 600 because systemd
reads it. Marker files can be root-owned 644 in non-writable directories.
The private-finances user must be able to read the credential files and connect
to its database. Do not copy secrets into unit files.

Complete and record a recovery drill first;
record snapshot ID, restored Git SHA, timestamp and successful comparisons. Only
then create `/etc/private-finances/off-server-restore-verified`, containing exactly
`off-server-restore-verified` and a newline. With S3 deferred, verified local recovery is also accepted via
`/etc/private-finances/local-restore-verified` containing `local-restore-verified`.
This does not protect against loss of the server. Scheduled imports require a
successful fresh local backup service; it atomically retains the recent and daily snapshots.
For each reviewed connector create
`/etc/private-finances/schedules/<provider>-<owner>.enabled`, containing exactly
that instance name and a newline. Both markers must be regular root-owned files
with no group/other write permission, in root-owned non-writable directories.
Marker existence is only a gate; the runner also checks ownership, mode and text.
The scheduler trusts the operator's recorded restore proof; it cannot perform or
independently validate the drill. Remove the restore marker when proof is no
longer valid (for example until a new migration's recovery drill passes).

Allowed instances: `monobank-rodion`, `monobank-katya`, and
`enablebanking-<rodion|katya>-<wise|revolut>`. Each bank is isolated. Enable only the specific timer whose credentials, owner,
account scope and pilot reconciliation have been verified. Example after all
gates: `systemctl enable --now private-finances-sync@monobank-rodion.timer`.
Enable Banking additionally needs that owner's valid consent session.

## Failures and disablement

Before invoking the CLI, the runner exclusively creates
`/var/lib/private-finances-sync/<instance>.blocked`. Success or recognized
transient/rate-limit failure removes it. Auth, consent, schema, incomplete,
configuration, unrecognized output, timeout or interruption leaves it in place.
Subsequent firings do not invoke that connector. Other instances are unaffected.
No child stdout/stderr is forwarded; journal events contain only the allowlisted
instance and scheduler result. The database retains the existing sanitized sync
failure status. A timeout may leave a job lease until its normal expiry.

Investigate the sanitized failure status and repair/revalidate credentials or
consent before removing the affected `.blocked` file. After an interrupted run,
check job/lease state and recovery first. Never clear latches in a timer or retry
loop. The service deadline is 45 minutes; its child invocation deadline is 40
minutes. An unusually large account set may need a separately reviewed deadline.

To disable future runs, stop/disable the instance timer and remove its enable
marker. Stopping the timer alone does not stop a currently running service; stop
that instance service as well when immediate cessation is needed. Removing the
global restore marker disables all future scheduled bank invocations. Manual
sync CLI runs remain an operator action and must obey the same restore prerequisite.

Inspect `systemctl list-timers 'private-finances-sync@*'`, the instance journal,
database sync failures and freshness after enablement. Alert delivery is not
implemented by these templates. Disabled and blocked schedules must not be
represented as fresh data or successful imports.

Tests exercise UTC/leap-year boundaries, gate failures, repeat windows, a
persistent failure latch, connector isolation and lack of immediate retries.
They never load bank credentials or call a bank API. Deployment evidence is recorded in STATUS.md.


## Timer rollout and rollback

The template applies the conservative six-hour schedule. Install both tracked
`private-finances-sync@monobank-<owner>.timer.d/frequency.conf` drop-ins under
`/etc/systemd/system/`, preserving the directory names, to select Monobank cadence.
Stop all five enabled timers (including Katya Wise) and wait for active sync services to finish before
switching releases. Preserve the old unit files, install the new template/service
and drop-ins, reload systemd, validate the instances and restart only previously
enabled timers. Inspect `TimersMonotonic`, interval accuracy and next firings.
Do not enable Katya Wise just because a generic timer template exists.

Rollback restores the saved unit template and removes newly introduced drop-ins,
then reloads systemd and restarts the same timers. Application rollback follows
the existing release procedure; retained cooldown files remain conservative.


## Previous hourly trial mechanism (superseded by half-hourly trial below)

The earlier trial included Rodion Wise and Revolut. Katya initially retained the
six-hour default after her verified import. The current trial below supersedes
those selections. For the legacy hourly mechanism, the generic six-hour default remains;
owner-specific one-hour timer drop-ins and root-owned, non-writable
`/etc/private-finances/schedules/<instance>.hourly` files containing the exact
instance opt into the trial. Success persists a one-hour cooldown under the same
exclusive invocation latch. Do not send fake PSU headers to represent background
requests as interactive requests.

A rate-limit or transient error writes `<instance>.conservative` in the scheduler
state directory. The existing 24-hour error cooldown remains (covering the
connector's maximum supported Retry-After); subsequent successes use six hours.
The one-hour timer may wake during this cooldown but performs no bank calls.
Fallback is sticky across restarts and isolated by connection. Auth, schema and
uncertain errors remain latched for operator review. Empty successful responses
and zero changed transactions are not evidence of a failure.

To roll out over an existing six-hour success cooldown, first verify that instance
is inactive, its latest sync succeeded and no error/fallback latch exists. Only
then replace its success cooldown with last-success plus one hour; never shorten
an error cooldown. Preserve the old files for rollback. Removing trial markers
restores six-hour success cooldowns; remove the timer drop-ins too when reverting.

The one-time September 12, 19:45 Europe/Riga follow-up completed on the next
wake after 22:01 Riga. All three connections had successful half-hour polling,
no fallback/auth latches and healthy Telegram queue delivery; see STATUS for
aggregate evidence. This check is complete and should not repeat. Delayed laptop
wakes do not affect server-side cooldown/fallback behavior.


## Half-hour trial (September 12 clarification)

The requested cadence is 30 minutes after completion for Rodion Wise/Revolut and
Katya Wise. Install their tracked 30-minute timer drop-ins and root-owned 644
`<instance>.half-hourly` markers containing the exact instance name. This marker
takes priority over a legacy hourly marker. The default without either opt-in is
six hours. Existing sticky conservative state always wins over both markers.
After a rate-limit/transient error, wait the existing 24-hour cooldown, then use
six hours between successful attempts. Auth/uncertain latches stay blocked.
No empty-result fallback and no fabricated online-user headers. On rollout shorten
only a known successful cooldown with no conservative marker or failure latch.
