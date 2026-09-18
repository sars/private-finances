# Isolated server deployment

First release de4b0aa installed and smoke-tested on 2026-09-11. The existing VPS has Node 24, PostgreSQL and Tailscale.
Port 3300 is available. No existing service needs a restart or configuration edit.

Host requirements, observed versions, configuration paths and systemd units are
recorded in [what the production server needs](../docs/server-requirements.md).
Update that file in the same change that introduces a new system dependency.

Layout:

- /opt/private-finances/releases/<tested Git SHA>: immutable application build.
- /opt/private-finances/current: atomic symlink to the active release.
- /etc/private-finances/app.env: root-owned mode 600, database URL and owner passwords.
- /etc/private-finances/credentials: server-only bank credentials, mode 700.
- Dedicated private-finances service user and private_finances database/role.

The dashboard binds loopback. Initially use an SSH tunnel over Tailscale:
`ssh -L 3300:127.0.0.1:3300 radar`, then open
http://localhost:3300 and sign in using the owner's separate password. This
preserves the application's Host checks and avoids a public listener. A direct
Tailscale HTTPS endpoint is still to be configured and tested.

Login usernames are rodion and katya. Passwords were generated on the server and
exist only in /etc/private-finances/app.env (root-owned mode 600). The owner can
retrieve their own password through an authenticated SSH session; never send it
to GitHub or this conversation.

Installed archive SHA-256:
`a5c903d42cd8473097d9ae9d18c5de0effb86ed916335cf6de6486846852ba5b`.
The install script records the executed first-install procedure; it deliberately
refuses to overwrite an existing installation. Subsequent rollout needs a separate
release-switch procedure. Server application tests: 22 passed, PostgreSQL-only
test skipped there but passed in CI. Local empty-database restore passed; off-server
backup and rollback remain unverified.

The owner deferred S3 setup and authorized imports and recurring polling after a
verified local restore. Before enabling a schedule, restore a current backup into
a separate disposable database and verify the imported data. Record local proof
with `/etc/private-finances/local-restore-verified`, containing exactly
`local-restore-verified`. A verified encrypted off-server recovery may instead use
`/etc/private-finances/off-server-restore-verified`, containing exactly
`off-server-restore-verified`. Local recovery does not establish off-server
protection; never create an off-server marker for a local-only exercise.

Either restore marker must be a root-owned regular file, no more than 1024 bytes,
not writable by group or others, and readable by the service user (mode 0644).
Every instance also requires `/etc/private-finances/schedules/<instance>.enabled`
with exactly its instance name and the same ownership/permissions. The application
validates both gates before invoking bank access; systemd only prechecks the
instance marker's existence. Marker creation and timer activation remain explicit
operator steps after verification. Install restricted bank credentials separately.
Do not put secrets in GitHub Actions or release artifacts. The server sync command is:
`node dist/src/sync-cli.js monobank rodion FROM_ISO TO_ISO`
with DATABASE_URL and CREDENTIALS_DIRECTORY supplied by restricted configuration.
Katya's token filename is monobank-kate-token. Enable Banking additionally needs
ENABLEBANKING_APPLICATION_ID, ENABLEBANKING_SESSION_DIRECTORY and
`enablebanking-<owner>-<bank>-session` files. Select a slug from
`src/connectors/banks.ts` — `wise`, `revolut`, `swedbank` or `lhv` — as the fifth CLI
argument (or ENABLEBANKING_BANK for a manual pilot). Scheduled instances must be
`enablebanking-<owner>-<slug>`;
Monobank remains `monobank-<owner>`. Each instance has its own enable marker,
retry cooldown and failure latch. Legacy bank-unspecified Enable Banking
instances are rejected; do not enable them. Status uses provider:owner:bank; the
provider:owner history it replaced was moved onto the bank that owns those
accounts by migration 57, and the empty per-owner row removed, so no connection
on the dashboard predates per-bank scheduling. Before
switching releases, confirm no old CLI/scheduler process is running: old and new
Enable Banking lease keys differ. A connection this release has no bank slug for
is shown by its slug and marked unrecognised — expected only after a rollback
past the release that added that bank.
The command imports one explicit complete window; it does not schedule or retry.
Never run concurrent CLI processes using the same bank token against different databases.

Initial rollout must build the exact green commit in a new release directory,
run checks against a disposable database, back up the application database,
record the previous symlink, switch atomically, restart only private-finances,
and verify authenticated readiness with its release SHA. Roll back the symlink
if readiness fails; never automatically downgrade schema. Automatic CD remains
disabled until rollout and rollback have both been demonstrated.

## Monthly assets snapshot

`private-finances-assets-snapshot.service` and `.timer` run
`holdings-snapshot-cli` on the last Thursday of the month at 10:05 Europe/Riga
as the application user with `app.env` and `sync.env`; the broker and exchange
feeds switch on when their files exist in the credentials directory
(`ibkr-flex-token`, `ibkr-flex-query`, `binance-api-key`, `binance-api-secret`,
mode 600, owned by the application user like the bank tokens). Installation and
a credential check are in [assets](../docs/assets.md).

## Releasing

`bash deploy/release.sh <40-character commit SHA>` performs that whole sequence as
one command against the `radar` SSH host: it transfers a Git archive of the exact
commit and checks its digest, builds and runs the application tests on the server,
restores the real database into a disposable copy and migrates _that_ with the new
code, pauses the sync timers and the worker until no import is running, installs
the root-owned release, hands over to `switch-release.py`, resumes the timers and
the worker, and prints the resulting release, schema version and transaction count.

Every step is a gate and the first failure stops the release, so a half-finished
attempt leaves the previous release serving and the build directory in place for
inspection. The rehearsal exists because the release rolled back on 13 September
2026 carried a migration that had only ever run on an empty database.

A failure after the pause restores the timers and the worker on its way out,
under a `restoring the imports and the worker a failed step had paused` heading,
and the release still exits with the status the failing step gave it. That was
added on 18 September 2026, when the pause itself refused — an import was still
running after the five minutes it waits — and left the imports and Telegram
stopped until the next run happened to resume them. If even the restore cannot
reach the host it says so loudly; start `private-finances-telegram.service` and
the `private-finances-sync@*` timers by hand in that case.
`bash deploy/test-resume.sh` proves all of this against a stubbed `ssh`, without
touching the server; run it whenever `release.sh` changes.

## Latest release

864c90d deployed 2026-09-14 with `bash deploy/release.sh 864c90d…`, replacing
5a29a1b. Archive digest matched after transfer, 396 application tests passed on
the server (3 skipped), and the migration rehearsal on a restored copy reached
schema version 26 in 84 ms with 3,911 transactions unchanged. After the switch
both services were active, seven timers were running and neither journal showed an
error. Predeploy dump and authenticated readiness passed, as `switch-release.py`
requires.

An intermediate switch to dcb497b in the same session was one commit behind the
running release and was corrected within minutes; the script now refuses a target
that does not contain the running release unless `--allow-rollback` is passed. See
[the incident note](../docs/incidents/2026-09-14-release-downgrade.md).

Scheduler timers remain enabled. Private Tailscale HTTPS is active. Manual
compatible rollback was previously demonstrated; automatic failure-triggered
rollback has still not been deliberately exercised.

## Open browser tabs across releases

`switch-release.py` retains the adjacent release's original fingerprinted JavaScript
and CSS files before switching. An old open tab can therefore fetch a lazy screen
chunk after deployment. The same assets are prepared in the rollback release before
switching; emergency rollback does not depend on copying files after a failure.

A root-only `.frontend-assets.json` manifest distinguishes native build files from
inherited files and verifies SHA-256 contents. Only native files propagate into the
next release, keeping retention to two builds rather than recursively accumulating
assets. Limits are 256 files, 64 MiB combined, and 10 MiB per file. Non-fingerprinted
files, HTML, API responses, bank data and secrets are not copied. Existing static
path checks, authentication and private immutable caching remain unchanged.

Filename collisions with differing content, symlinks, changed tracked assets and
limit violations stop preflight. Deploy from a clean verified build if an interrupted
asset-preparation step leaves an incomplete manifest or staging file; do not bypass
validation. Each release's original assets and HTML are preserved. Tabs older than
the retained adjacent build must refresh; asset retention does not guarantee old
JavaScript remains compatible with a changed API.

Synthetic regression: `python3 scripts/test_frontend_assets.py` (also included in
the Node test suite). It covers adjacent retention, rollback preparation, no recursive
copying, idempotence, collisions, tampering, path safety and size/count boundaries.

## Verified server identity (September 12, 2026)

Read-only SSH identity checks confirmed that the deployment endpoint and the
owner-selected private Tailscale host are the same machine, and that it serves
`/opt/private-finances/current`. Its addresses and private hostname are in
`~/.config/private-finances/server-access.md`, which is deliberately outside
Git; the `radar` alias used throughout resolves only through the operator's own
`~/.ssh/config`. Use existing host-key verification; re-check identity if the
endpoint changes.
Release transfers use tracked-source Git archives, excluding local keys, credentials,
statement exports and runtime data. Credentials remain in the existing server paths.
