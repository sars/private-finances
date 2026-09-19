# Bringing it up

Three situations, in increasing order of how rarely they happen: running it on a
laptop, releasing a new version onto the server that already runs it, and
rebuilding the whole thing on a machine that has never seen it.

The third is the one worth writing down, because it is the one nobody will have
done recently when it is needed.

## On a laptop, with no credentials

```sh
pnpm install --frozen-lockfile
pnpm demo
```

Open <http://127.0.0.1:3300>. This is a synthetic workspace: it imports example
transactions, and it never touches a bank, the household's data or the server.
[Local development](development.md) covers the rest — an isolated PostgreSQL,
screenshots, the checks.

## A new release onto the running server

One command, from a checkout at `origin/main`:

```sh
bash deploy/release.sh <40-character commit sha>
```

It gates on the archive digest, the application tests on the server, and a
migration rehearsal against a restored copy of the real database before anything
is switched; it pauses the imports and the worker around the switch and puts them
back; and it refuses a commit that is not on `origin/main`, or one older than
what is running unless `--allow-rollback` is passed. A half-finished attempt
leaves the previous release serving. This runs several times a day and is the
best-exercised path in the project.

## On a machine that has never run it

This is the path that matters after a disaster, and the honest caveat comes
first: **it has not been rehearsed end to end on a bare machine.** The restore
steps are proved — the database and the configuration have both been restored
from the bucket and compared against the live server — and the release step runs
daily. The order below is assembled from `deploy/initial-install.sh`, which
records what the first install actually executed, and from the server as it is
today. Expect to fix a detail or two, and correct this file when you do.

### 1. The machine

Ubuntu 24.04 on x86_64. [What the production server needs](server-requirements.md)
is the authoritative list of packages and versions; as installed today:

```sh
# PostgreSQL 16, and the tools the application shells out to
sudo apt-get install -y postgresql postgresql-client restic caddy \
  poppler-utils python3 git curl

# Node 24 from NodeSource; pnpm comes from corepack inside it
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable pnpm
```

Then Tailscale, joined to the tailnet, which is how the dashboard is reached at
all. Nothing about this application is exposed to the public internet.

### 2. The credentials, out of the backup

Before anything else, because everything below reads them. On the new machine,
with the repository password from the password manager and an AWS key for the
bucket (make a new one in IAM if the old is lost — it is replaceable, the
repository password is not):

```sh
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
export RESTIC_REPOSITORY=s3:s3.<region>.amazonaws.com/<bucket>
sudo -E restic restore latest --tag config --target /
```

That puts back `/etc/private-finances` — the environment files, the bank PEM
keys, the tokens, the schedule markers — along with the project's systemd units,
`/etc/caddy` and `/etc/postgresql`. The bucket and region are recorded outside
Git in `~/.config/private-finances/aws-backup.md`, which also holds this
procedure in case this file is unreachable.

### 3. The user, the directories, the database

```sh
sudo useradd --system --home-dir /var/lib/private-finances --create-home \
  --shell /usr/sbin/nologin private-finances
sudo install -d -m 755 /opt/private-finances/releases
sudo install -d -m 700 /var/lib/private-finances/predeploy
sudo -u postgres createuser --no-superuser --no-createdb --no-createrole private-finances
sudo -u postgres createdb --owner=private-finances private_finances
```

The application connects over the unix socket as this user and PostgreSQL
authenticates it by peer, so the operating-system user _is_ the credential and
there is no database password anywhere. `DATABASE_URL` in the restored `app.env`
already says so.

### 4. The data, out of the backup

```sh
sudo -E restic restore latest --tag database --target /var/tmp/recover
sudo -u postgres pg_restore --exit-on-error --no-owner --no-acl \
  -d private_finances /var/tmp/recover/database.dump
sudo rm -rf /var/tmp/recover
```

Never restore over a database that is serving. On a rebuild it is empty, which is
the only safe case.

### 5. The release

From a checkout on any machine that can reach the new server:

```sh
bash deploy/release.sh <the sha recorded in docs/STATUS.md>
```

The application runs migrations itself at startup, so a restored database one or
two schema versions behind catches up on the first boot. The release script's
rehearsal will say so before anything switches.

### 6. What only a person can do

- **Tailscale** must be re-authenticated, and `tailscale serve` pointed at
  `127.0.0.1:3300` again. A restored node key is not reused: it would be a second
  machine claiming one identity.
- **Bank approvals** must be given again by each owner through **Bank
  connections**. Consents last days, not months, so they are always expired after
  an incident — the restored PEM keys and tokens are what save the slow part, not
  the approvals.
- **The schedule markers** in `/etc/private-finances/schedules/` come back with
  the configuration, but check them: they are what allows a timer to touch a bank
  at all, alongside a restore-verified marker.

### 7. Before believing it

```sh
systemctl is-active private-finances.service private-finances-telegram.service
systemctl list-timers 'private-finances*'
```

Then open the dashboard and look at **System health**: the running release, the
database, and the off-server backup's age. If the backup card says **Never**, the
new machine is not backing anything up yet — install and enable
`private-finances-backup.timer`, and run it once by hand.

Finally, take a backup on the new machine and prove it restores, as
[the backup runbook](backups.md) describes. A rebuilt server that cannot be
rebuilt again is halfway to the same incident.
