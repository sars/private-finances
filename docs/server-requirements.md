# What the production server needs

Everything the deployment depends on outside the Node dependency tree. The
lockfile records npm packages; nothing records system-level requirements unless
they are written here, and an undocumented one stays invisible until the server is
rebuilt, migrated, or a release fails on a machine that happens to lack it.

Versions below were observed on the running server on September 13, 2026. Record
what you observe rather than what you expect, and update this file in the same
change that introduces a new requirement.

## Host

Ubuntu 24.04.4 LTS on x86_64, reached as the SSH host `radar`. Its public and
Tailscale addresses and its private hostname are recorded in
`~/.config/private-finances/server-access.md`, outside Git; the alias resolves
only through the operator's own `~/.ssh/config`, so it discloses nothing. The
machine also runs unrelated applications, so never restart or reconfigure anything
outside the `private-finances` units.

## System packages

| Requirement | Observed | Used for | Without it |
| --- | --- | --- | --- |
| Node.js | 24.15.0 | the application and all workers | nothing runs; `package.json` requires `>=24.15.0 <25` |
| pnpm | 11.19.0 | installing and building a release | a release cannot be built on the server |
| PostgreSQL server | 16.15 | all persistent data | nothing runs |
| `psql` client | 16.x | migration checks, disposable-database verification, diagnosis | release verification, `scripts/receipt-diagnosis.sql` and `scripts/category-diagnosis.sql` cannot run |
| python3 | 3.12.3 | `deploy/switch-release.py`, `scripts/check_repository.py`, `scripts/archive_status.py` | releases cannot be switched |
| poppler-utils (`pdftoppm`, `pdfinfo`) | 24.02.0 | rendering PDF receipts to page images | PDF receipts fail with `receipt_pdf_render_failed`; photos are unaffected |
| Tailscale | 1.102.2 | the private HTTPS endpoint | the dashboard is unreachable |
| curl | 8.5.0 | operator checks | manual verification only |
| git | 2.43.0 | receiving release archives | releases cannot be staged |

Only poppler-utils is optional in the sense that the application keeps working
without it: a PDF receipt is marked failed with a fixed explanation and the owner
is asked for a photo instead. Every other entry is required for the service to run.

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

- `/opt/private-finances/releases/<commit sha>` — immutable built releases, root owned.
- `/opt/private-finances/current` — symlink to the active release, switched atomically.
- `/var/lib/private-finances/predeploy/` — automatic `pg_dump` taken before every switch.
- `/etc/private-finances/` — root-owned configuration, mode 600.

## Configuration and credentials

`/etc/private-finances/` holds `app.env` (database URL, owner passwords, the
active `RELEASE_SHA`), `sync.env`, `telegram.env`, `historical-knowledge.json`,
the `schedules` directory, and the marker files `telegram.enabled` and
`local-restore-verified`. Credentials live in `/etc/private-finances/credentials/`
(mode 700): Enable Banking PEM keys, Monobank tokens, the OpenAI API key and the
Telegram bot token. None of these belong in Git, an artifact, a log or a model
prompt; this file deliberately lists only their names.

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
`monobank-katya`, plus `private-finances-fx-sync` and `private-finances-reports`.
`private-finances-local-backup` is installed but not enabled.

## Known deviations

The deployment user has unrestricted passwordless sudo and `sshd_config` sets
`PermitRootLogin yes`, so holding that key is effectively root. Both are recorded
in [the deployment contract](operations.md) and tracked as OPS-4; neither was
changed, because narrowing them risks locking access out mid-task.
