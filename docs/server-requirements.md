# What the production server needs

Everything the deployment depends on outside the Node dependency tree. The
lockfile records npm packages; nothing records system-level requirements unless
they are written here, and an undocumented one stays invisible until the server is
rebuilt, migrated, or a release fails on a machine that happens to lack it.

Versions below were observed on the running server on September 13, 2026, except
restic and aws-cli, observed on September 19. Record what you observe rather than
what you expect, and update this file in the same change that introduces a new
requirement.

## Host

Ubuntu 24.04.4 LTS on x86_64, reached as the SSH host `radar`. Its public and
Tailscale addresses and its private hostname are recorded in
`~/.config/private-finances/server-access.md`, outside Git; the alias resolves
only through the operator's own `~/.ssh/config`, so it discloses nothing. The
machine also runs unrelated applications, so never restart or reconfigure anything
outside the `private-finances` units.

## System packages

| Requirement                           | Observed | Used for                                                                                   | Without it                                                                                                                                  |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                               | 24.15.0  | the application and all workers                                                            | nothing runs; `package.json` requires `>=24.15.0 <25`                                                                                       |
| pnpm                                  | 11.19.0  | installing and building a release                                                          | a release cannot be built on the server                                                                                                     |
| PostgreSQL server                     | 16.15    | all persistent data                                                                        | nothing runs                                                                                                                                |
| `psql` client                         | 16.x     | migration checks, disposable-database verification, diagnosis                              | release verification, `scripts/receipt-diagnosis.sql` and `scripts/category-diagnosis.sql` cannot run                                       |
| python3                               | 3.12.3   | `deploy/switch-release.py`, `scripts/check_repository.py`, `scripts/archive_status.py`     | releases cannot be switched                                                                                                                 |
| poppler-utils (`pdftoppm`, `pdfinfo`) | 24.02.0  | rendering PDF receipts to page images                                                      | PDF receipts fail with `receipt_pdf_render_failed`; photos are unaffected                                                                   |
| Tailscale                             | 1.102.2  | the private HTTPS endpoint                                                                 | the dashboard is unreachable                                                                                                                |
| curl                                  | 8.5.0    | operator checks                                                                            | manual verification only                                                                                                                    |
| git                                   | 2.43.0   | receiving release archives                                                                 | releases cannot be staged                                                                                                                   |
| restic                                | 0.16.4   | the daily encrypted off-server backup ([backups](backups.md))                              | nothing is copied off this machine; `private-finances-backup.service` fails at the upload stage and System health reports the backup ageing |
| aws-cli (snap)                        | 2.35.21  | **diagnosis only** — installed 19 September 2026 to find out why a bucket call was refused | nothing breaks; the backup never invokes it                                                                                                 |

Only poppler-utils and aws-cli are optional. Without poppler-utils a PDF receipt
is marked failed with a fixed explanation and the owner is asked for a photo
instead; aws-cli is an operator's tool that no code path calls. Without restic
the application itself is unaffected — nothing crashes and no screen breaks —
but the household loses its only off-server copy, which System health states
rather than hides. Every other entry is required for the service to run.

Install restic, if a rebuilt host lacks it, with `sudo apt-get install restic`.
Ubuntu 24.04 ships 0.16.4, which is sufficient. The backup script invokes it
twice per run — once streaming the database dump on stdin, once with the
configuration paths — and never through a shell.

Two PostgreSQL capabilities became load-bearing at schema version 25, both part
of a stock server rather than extensions to install. The category tree enforces
its invariants with `plpgsql` triggers, so the language must be available —
it is installed and trusted by default, and only a deliberately stripped build
would lack it. Those triggers also call `gen_random_uuid()`, which is built in
from PostgreSQL 13 onward and needs no `pgcrypto`. A rebuilt host running the
observed 16.15 satisfies both without extra packages; a host below 13 would fail
the migration outright rather than misbehave quietly.

Install poppler-utils, if a rebuilt host lacks it, with
`sudo apt-get install --no-install-recommends poppler-utils`. It pulls no
Ghostscript and no ImageMagick; the application invokes `pdftoppm` and `pdfinfo`
directly through `execFile` with an argument array, never a shell.

## Filesystem layout

- `/opt/private-finances/releases/<commit sha>` — immutable built releases, root
  owned. Each is a complete tree with its own `node_modules`, about 518 MB.
- `/opt/private-finances/current` — symlink to the active release, switched atomically.
- `/var/lib/private-finances/predeploy/` — automatic `pg_dump` taken before every switch.
- `/etc/private-finances/` — root-owned configuration, mode 600.

**Both growing directories are now bounded, and both were not.** On 19 September
2026 the releases directory held 136 trees and 45 GB and the predeploy directory
138 dumps and 442 MB, on a root filesystem 92% full and shared with other
applications; at about seventeen releases a day that is roughly 8.8 GB a day
against 7.9 GB free, so it had well under a day left. `deploy/switch-release.py`
now prunes both after a switch has succeeded — the newest ten releases plus
whatever `current` points at, and the backup rule of fourteen recent dumps plus
one per day for fourteen days. A failed release prunes nothing, and a prune that
fails is reported without failing a deployment that already worked.

Neither rule will ever remove a name it does not recognise: releases must match a
40-character commit SHA, dumps must begin with a digit. The predeploy directory
also holds six deliberately named milestones — `initial-empty`,
`schema-v3-empty`, `before-monobank-pilot`, `before-enablebanking-pilot`,
`pilot-records-verified`, `verified-live-dataset` — which a plain "keep the
newest N" rule would have destroyed.

## Configuration and credentials

`/etc/private-finances/` holds `app.env` (database URL, owner passwords, the
active `RELEASE_SHA`), `sync.env`, `telegram.env`, `backup.env`,
`historical-knowledge.json`, the `schedules` directory, and the marker files
`telegram.enabled`, `local-restore-verified` and `off-server-restore-verified`.
Credentials live in `/etc/private-finances/credentials/` (mode 700): Enable
Banking PEM keys, Monobank tokens, the OpenAI API key and the Telegram bot token.
None of these belong in Git, an artifact, a log or a model prompt; this file
deliberately lists only their names.

Both backup files are root-only, and a rebuilt host should keep them that way:

- `backup.env` is `root:root` mode `600`. systemd reads it as root and injects
  it into `private-finances-backup.service` alone, which is how the AWS keys
  inside it stay unreadable by every other process.
- the restic repository password lives in its own file, named by
  `RESTIC_PASSWORD_FILE`, owned `root:root` mode `600`. The backup service runs
  as root, so nothing unprivileged needs to read it — in particular the web
  application's user cannot.

`backup.env` contains no database password. The connection is peer-authenticated
over the unix socket, so the operating-system user is the credential and there is
no `PGPASSFILE` — a rebuilt host must keep `PGUSER` matching the OS user running
the service, or `pg_dump` is refused.

## systemd units

`private-finances.service` (dashboard) and `private-finances-telegram.service`
(worker) are enabled and run from `/opt/private-finances/current`. Note that
`deploy/switch-release.py` restarts **only** the dashboard, so the worker must be
stopped before a switch and started after it, or it keeps running the previous
release. The worker also matches refunds once a minute ([refunds](refunds.md));
that pass needs no new package, binary, secret or network access, so a stopped
worker delays refund matching rather than breaking anything.

Enabled timers: `private-finances-sync@` for `enablebanking-rodion-wise`,
`enablebanking-rodion-revolut`, `enablebanking-katya-wise`, `monobank-rodion` and
`monobank-katya`, plus `private-finances-fx-sync`, `private-finances-reports` and
`private-finances-backup` (daily, 03:30 UTC, `Persistent=true`, up to fifteen
minutes of randomised delay). `private-finances-local-backup` is installed but
not enabled.

`private-finances-fx-sync` reaches two hosts outbound, both over HTTPS and
neither authenticated: `api.privatbank.ua` for the primary commercial archive,
and `minfin.com.ua` for the average bank rate on the days PrivatBank publishes
nothing. The second is requested only for those days — a handful a year — so a
host allow-list needs both, but only the first sees nightly traffic. Neither
carries a credential, so neither belongs in `backup.env` or anywhere else.

`private-finances-backup.service` is the only unit that reads `backup.env`, and
the only one that **runs as root** — deliberately, because it backs up the
server's configuration as well as its database, and that configuration is
precisely what no unprivileged process may read. It only ever reads: it runs
under `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true` and
`NoNewPrivileges=true`, with `CacheDirectory=` giving restic
`/var/cache/private-finances-restic`, and needs that cache directory, a writable
private `/tmp` for the dump, and nothing else. It drops to `private-finances`
with `runuser` for `pg_dump` and `psql`, so the database is never touched as
root; `runuser` (util-linux) preserves the `PG*` environment, which peer
authentication depends on.

It also requires `runuser`, which is part of `util-linux` and present on any
Ubuntu host, and `python3`, already required above, to read restic's JSON
summary.

## Known deviations

The deployment user has unrestricted passwordless sudo and `sshd_config` sets
`PermitRootLogin yes`, so holding that key is effectively root. Both are recorded
in [the deployment contract](operations.md) and tracked as OPS-4; neither was
changed, because narrowing them risks locking access out mid-task.
