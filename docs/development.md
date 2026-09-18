# Local development

Use Node from `.nvmrc` and pnpm from `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

Open http://127.0.0.1:3300. Click **Import example transactions**, then refresh
after the next worker tick (one second). Classify an outflow as a personal expense
with category and reason. The corresponding currency total changes. Re-importing
the examples creates no duplicates. No external API requests are made by the app.

Demo data persists in `data/demo`. Only one demo process may use that directory.
Do not put real transactions into demo storage. Stop with Ctrl-C; startup resumes
queued jobs and recovers expired leases.

On this Mac the bundled Node/pnpm may not be on the shell PATH:

```sh
export PATH="/Users/rodik/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH:/Users/rodik/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
pnpm demo
```

The order is deliberate. Node goes first because nothing else on the machine
provides it, but `bin/fallback` goes last: it contains a bundled, unsigned `git`
that shadows Apple's notarized `/usr/bin/git` if it comes first, and the local
security tool then raises an allow/block prompt on every `git` call — including
the `git ls-files` inside `scripts/check_repository.py`, so every `pnpm check`
triggers one. Last still finds `pnpm` there, because nothing else provides it.

## Looking at a screen

Frontend rules live in `frontend/DESIGN.md`; the procedure for building a
screen is the `frontend-screen` skill under `.claude/skills/`. To see a change
rather than reason about it, run the demo in one shell and render routes in
another:

```sh
pnpm demo
pnpm shots /review /analytics        # .shots/*.png at 390 and 1280 px
SHOTS_DARK=1 pnpm shots              # add dark mode when tokens changed
```

`scripts/shots.ts` uses Playwright, a development dependency only; the browser
it drives is installed once with `pnpm exec playwright install chromium` and is
not needed on the server. `.shots/` is ignored by Git because the images show
whatever data the server holds.

## Keeping macOS out of the build output

Several agents work at once, each in its own worktree with its own
`node_modules`, and Spotlight indexes all of them. The files are worthless to
search and the indexing is not free: with ten checkouts present the project
alone accounted for about 160,000 files, and `mds_stores`, `fseventsd` and the
storage scanner ran continuously because of it.

A `.metadata_never_index` file makes Spotlight skip the directory it sits in.
`postinstall` writes one into `node_modules` (`scripts/hide-node-modules-from-spotlight.mjs`)
so the exclusion survives every `pnpm install`; it is macOS-only and never fails
an install, so CI and the server are unaffected.

For everything else — `dist`, `.git`, caches, other repositories on the machine —
run `exclude-dev-caches` (in `~/.local/bin`). It is idempotent, so run it again
after cloning a repository or creating a worktree. It also drops the regenerable
directories from Time Machine, but deliberately leaves `.git` in the backup,
since unpushed history exists nowhere else.

Stale worktrees are the other half of this. A worktree whose branch is merged
still costs a full `node_modules`; remove it with `git worktree remove` once its
pull request lands.

## Isolated PostgreSQL

Set APP_MODE=postgres, DATABASE_URL, both RODION_EMAIL/KATYA_EMAIL and both
RODION_PASSWORD/KATYA_PASSWORD (at least 20 characters each) through a secret
environment file. The application does not automatically load `.env`. It
applies the versioned schema at startup, writes those four values into the
`users` table, and serves a sign-in screen on its loopback listener — see
[authentication.md](authentication.md). For private server access, configure
the TLS proxy and access checks before deployment.

## Checks

`pnpm check`: repository hygiene, formatting, TypeScript build, Node test runner.
Local tests use fresh in-memory PGlite databases and ephemeral HTTP ports.
Set TEST_DATABASE_URL only to a dedicated disposable test DB to exercise the real
PostgreSQL test. The CI job creates that service automatically. That test skips
locally when no isolated PostgreSQL database is configured; the skip is visible.

## HTTP endpoints

- GET `/` — transaction list, owner filter and classification forms.
- GET `/ops`, `/api/ops` — dependency/freshness/job status.
- GET `/api/transactions`, `/api/summary` — optional owner=rodion or owner=katya.
- GET `/health/live` — process liveness; GET `/health/ready` — database readiness.
- POST `/import` — queue fixed synthetic data; POST `/classify` — audited owner edit.
- GET `/api/holdings`, POST `/api/holdings`, `/api/holdings/fill`, `/api/holding-snapshots`, `/api/asset-prices` — household assets; see [assets](assets.md).

POST endpoints use form encoding and a CSRF token from the page. Unsupported or
invalid requests receive a sanitized error and request ID. Request logs omit URLs,
descriptions, form contents and credentials. Source/audit records remain in the DB.
