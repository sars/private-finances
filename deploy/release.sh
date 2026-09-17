#!/bin/bash
# One command per release: build the exact commit on the server, prove the
# migration against a restored copy of the real database, switch atomically and
# verify. Every step is a gate; the first failure stops the release.
#
#   bash deploy/release.sh <40-character commit SHA> [ssh host, default radar]
#
# Safe to re-run: a half-finished attempt leaves the previous release serving,
# and nothing is switched until the rehearsal has passed.
set -euo pipefail

sha=${1:-}
host=radar
allow_rollback=
for argument in "${@:2}"; do
  case $argument in
  --allow-rollback) allow_rollback=1 ;;
  *) host=$argument ;;
  esac
done
[[ $sha =~ ^[0-9a-f]{40}$ ]] || {
  echo "usage: bash deploy/release.sh <40-character commit SHA> [ssh host] [--allow-rollback]" >&2
  exit 64
}
git fetch -q origin
git merge-base --is-ancestor "$sha" origin/main 2>/dev/null || {
  echo "refusing: $sha is not on origin/main" >&2
  exit 65
}

# Another agent may have released while this one was working. Deploying an older
# commit would silently withdraw their fix, so the currently running release has
# to be an ancestor of the target unless a rollback is asked for explicitly.
deployed=$(ssh -o BatchMode=yes "$host" \
  "sudo -n grep -o 'RELEASE_SHA=[0-9a-f]*' /etc/private-finances/app.env | cut -d= -f2")
if [ "$deployed" = "$sha" ]; then
  echo "$sha is already the running release"
  exit 0
fi
if [ -z "$allow_rollback" ]; then
  git cat-file -e "$deployed^{commit}" 2>/dev/null || {
    echo "refusing: the running release $deployed is unknown here; fetch it or pass --allow-rollback" >&2
    exit 65
  }
  git merge-base --is-ancestor "$deployed" "$sha" || {
    echo "refusing: $sha does not contain the running release $deployed; pass --allow-rollback to go back deliberately" >&2
    exit 65
  }
fi
echo "replacing $deployed"
short=${sha:0:7}
build=/tmp/pf-build-$short
archive=/tmp/pf-$short.tar.gz
step() { printf '\n=== %s ===\n' "$1"; }

step "transferring $short"
digest=$(git archive --format=tar "$sha" | gzip -9 | tee /tmp/pf-release-local.tar.gz |
  shasum -a 256 | cut -d' ' -f1)
remote_digest=$(ssh -o BatchMode=yes "$host" "cat > $archive && sha256sum $archive" \
  < /tmp/pf-release-local.tar.gz | cut -d' ' -f1)
rm -f /tmp/pf-release-local.tar.gz
[ "$digest" = "$remote_digest" ] || {
  echo "refusing: archive checksum differs after transfer" >&2
  exit 65
}
echo "archive sha256 $digest"

step 'building on the server'
ssh -o BatchMode=yes "$host" "set -e
  rm -rf $build && mkdir -p $build && tar -xzf $archive -C $build
  cd $build && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null
  test -f dist/src/main.js && test -f dist/frontend/index.html
  chmod -R go+rX $build"

# Piping the run into tail would report tail's success and let a release past
# failing tests, which is exactly what happened on 15 September.
step 'application tests on the server'
ssh -o BatchMode=yes "$host" "cd $build
  # One at a time: the server runs the application and the worker alongside
  # this, and two suites at once have been enough to exhaust its memory and
  # fail tests that pass everywhere else.
  node --test --test-concurrency=1 dist/test/*.test.js > /tmp/pf-tests.log 2>&1
  status=\$?
  tail -6 /tmp/pf-tests.log
  exit \$status"

# The migration has to be proven against a database that is already at the
# deployed schema version. A release was rolled back on 13 September 2026
# because its migration had only ever run on an empty one.
step 'migration rehearsal on a restored copy'
ssh -o BatchMode=yes "$host" "set -e
  cat > /tmp/pf-migrate-check.mjs <<'CHECK'
const { postgresDatabase, migrate } = await import(
  process.env.RELEASE_DATABASE_MODULE,
);
const db = postgresDatabase(process.env.DATABASE_URL);
const started = Date.now();
await migrate(db);
const one = async (sql) => (await db.query(sql)).rows[0].v;
console.log(
  JSON.stringify({
    migrationMs: Date.now() - started,
    schema: await one('select max(version)::int as v from schema_versions'),
    transactions: await one('select count(*)::int as v from transactions'),
    activeRefundLinks: await one(
      \"select count(*)::int as v from refund_links where state='active'\",
    ),
    expensesWithoutCategory: await one(
      \"select count(*)::int as v from transactions where kind='personal_expense' and category is null\",
    ),
    filedOnHeading: await one(
      'select count(*)::int as v from transactions t join category_tree c on c.id=t.category_id where exists(select 1 from category_tree k where k.parent_id=c.id)',
    ),
  }),
);
await db.close();
CHECK
  chmod go+r /tmp/pf-migrate-check.mjs
  sudo -n -u postgres dropdb --if-exists private_finances_migration_check
  sudo -n -u postgres createdb --owner=private-finances private_finances_migration_check
  sudo -n -u postgres pg_dump -Fc private_finances > /tmp/pf-rehearsal.dump
  sudo -n -u postgres pg_restore --no-owner --role=private-finances -d private_finances_migration_check /tmp/pf-rehearsal.dump 2>/dev/null || true
  sudo -n -u private-finances env \
    DATABASE_URL='postgresql:///private_finances_migration_check?host=/var/run/postgresql&user=private-finances' \
    RELEASE_DATABASE_MODULE=$build/dist/src/database.js \
    node /tmp/pf-migrate-check.mjs
  sudo -n -u postgres dropdb private_finances_migration_check
  rm -f /tmp/pf-rehearsal.dump /tmp/pf-migrate-check.mjs"

# The build and the rehearsal take minutes, long enough for another agent to
# release in the meantime. On September 17, 2026 exactly that happened: the
# ancestry check above passed against one release, another session switched to
# a newer one during the rehearsal, and the switch below then quietly withdrew
# it. So the running release is read again here, and the same rule applies.
step 'confirming the running release has not moved'
deployed_now=$(ssh -o BatchMode=yes "$host" \
  "sudo -n grep -o 'RELEASE_SHA=[0-9a-f]*' /etc/private-finances/app.env | cut -d= -f2")
if [ "$deployed_now" != "$deployed" ]; then
  echo "the running release moved from $deployed to $deployed_now during the build"
  if [ "$deployed_now" = "$sha" ]; then
    echo "$sha is already the running release"
    exit 0
  fi
  if [ -z "$allow_rollback" ]; then
    git fetch -q origin
    git cat-file -e "$deployed_now^{commit}" 2>/dev/null &&
      git merge-base --is-ancestor "$deployed_now" "$sha" || {
      echo "refusing: $sha does not contain the running release $deployed_now; release a commit that does" >&2
      exit 65
    }
  fi
  deployed=$deployed_now
fi

# Imports write while they run and the worker holds leases; both pause for the
# switch so no process is left speaking the previous schema. The enabled set is
# read from systemd's own wants directory, so a re-run after a stopped attempt
# still knows which timers to bring back.
step 'pausing imports and the worker'
ssh -o BatchMode=yes "$host" "set -e
  timers=\$(ls /etc/systemd/system/timers.target.wants/ | grep '^private-finances-sync@' || true)
  printf '%s\n' \"\$timers\" > /tmp/pf-paused-timers
  if [ -n \"\$timers\" ]; then sudo -n systemctl stop \$timers; fi
  sudo -n systemctl stop private-finances-telegram.service
  # The bracket keeps this very command line, which contains the pattern, out of
  # its own match; without it the check always finds itself.
  for attempt in \$(seq 1 60); do
    pgrep -f '[s]ync-cli.js' >/dev/null || break
    sleep 5
  done
  if pgrep -f '[s]ync-cli.js' >/dev/null || \
     systemctl is-active --quiet 'private-finances-sync@*.service'; then
    echo 'an import is still running' >&2
    exit 75
  fi
  echo paused"

step 'installing and switching'
ssh -o BatchMode=yes "$host" "set -e
  sudo -n rm -rf /opt/private-finances/releases/$sha
  sudo -n cp -a $build /opt/private-finances/releases/$sha
  sudo -n chown -R root:root /opt/private-finances/releases/$sha
  sudo -n chmod -R go+rX /opt/private-finances/releases/$sha
  sudo -n python3 /opt/private-finances/releases/$sha/deploy/switch-release.py $sha --schema-compatible"

step 'resuming imports and the worker'
ssh -o BatchMode=yes "$host" "set -e
  sudo -n systemctl start private-finances-telegram.service
  timers=\$(cat /tmp/pf-paused-timers)
  if [ -n \"\$timers\" ]; then sudo -n systemctl start \$timers; fi
  rm -f /tmp/pf-paused-timers
  echo resumed"

step 'verifying'
ssh -o BatchMode=yes "$host" "set -e
  active=\$(systemctl is-active private-finances.service private-finances-telegram.service | tr '\n' ' ' || true)
  released=\$(sudo -n grep -o 'RELEASE_SHA=[0-9a-f]*' /etc/private-finances/app.env | cut -d= -f2)
  schema=\$(sudo -n -u postgres psql -d private_finances -tAc 'select max(version) from schema_versions')
  rows=\$(sudo -n -u postgres psql -d private_finances -tAc 'select count(*) from transactions')
  printf '{\"services\":\"%s\",\"release\":\"%s\",\"schema\":%s,\"transactions\":%s}\n' \
    \"\$active\" \"\$released\" \"\$schema\" \"\$rows\"
  [ \"\$released\" = '$sha' ] || exit 76"

step 'cleaning up the build directory'
ssh -o BatchMode=yes "$host" "rm -rf $build $archive"
echo "deployed $sha"
