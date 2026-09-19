#!/usr/bin/env bash
# Daily encrypted off-server backup: the database, and the server configuration
# needed to rebuild the machine around it. Both go to one restic repository in a
# private Amazon S3 bucket, in one run, under one credential. See docs/backups.md.
#
# PostgreSQL connection uses PGHOST/PGPORT/PGUSER/PGDATABASE.
# Restic credentials are supplied through a restricted service EnvironmentFile.
#
# **This runs as root**, because the configuration worth saving is the part no
# unprivileged process may read: the bank keys, the tokens, the environment
# files. The database is not touched as root — `pg_dump` and `psql` drop to the
# service user, whose name is the credential, because that connection is
# peer-authenticated over the unix socket.
#
# Every attempt, successful or not, is recorded in the application's own
# backup_runs table so that the operations page can say whether the household's
# data exists anywhere but this machine. The recording uses the same libpq
# variables as the dump, so it introduces no second credential, and it stores a
# destination label rather than the bucket URL: the row travels inside the very
# dump that gets uploaded, and the bucket address is private configuration.
set -euo pipefail
umask 077
: "${PGDATABASE:?PGDATABASE required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE required}"
destination="${BACKUP_DESTINATION_LABEL:-amazon-s3}"
dump_user="${BACKUP_DUMP_USER:-private-finances}"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
backup_work=$(mktemp -d)
trap 'rm -rf -- "$backup_work"' EXIT

# A recorded status is worth having and never worth losing a good backup over:
# a successful upload that could not be written down shows on the page as an
# ageing backup, which errs towards alarm rather than false comfort. The failure
# is reported as its own event instead of being swallowed.
recorded=false
record() {
  local outcome="$1" stage="$2" snapshot="$3" size="$4"
  # The statement goes in on stdin, never through --command. `psql -c` sends its
  # argument straight to the server, so the `:'name'` placeholders below — a
  # client-side feature — arrive at PostgreSQL verbatim and fail to parse. Read
  # from stdin psql expands them itself, quoting each value as a literal, which
  # is what keeps a value out of the SQL grammar. ON_ERROR_STOP is what makes a
  # rejected statement an exit code rather than a silent success.
  if runuser -u "$dump_user" -- psql --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 \
    --set=destination="$destination" --set=outcome="$outcome" \
    --set=stage="$stage" --set=started="$started_at" \
    --set=snapshot="$snapshot" --set=size="$size" \
    >/dev/null 2>"$backup_work/record_error" <<'SQL'
INSERT INTO backup_runs(id,destination,outcome,stage,started_at,finished_at,snapshot_id,size_bytes)
VALUES (gen_random_uuid(),:'destination',:'outcome',nullif(:'stage',''),:'started'::timestamptz,now(),
        nullif(:'snapshot',''),nullif(:'size','')::bigint);
SQL
  then
    recorded=true
  else
    recorded=false
    echo '{"event":"backup_status_unrecorded","outcome":"'"$outcome"'"}' >&2
  fi
}

# restic --json writes one JSON object per line and ends with a summary naming
# the snapshot it created. A missing summary means the upload cannot be proven,
# so the run is recorded without a snapshot id rather than claimed as verified.
read_snapshot() {
  python3 - "$1" <<'PY'
import json, re, sys
snapshot = ''
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if event.get('message_type') == 'summary' and event.get('snapshot_id'):
        snapshot = str(event['snapshot_id'])
print(snapshot if re.fullmatch(r'[0-9a-f]{8,64}', snapshot) else '')
PY
}

# What has to exist again on a rebuilt machine, and exists nowhere else. The
# application's own code is not here: it is in a public repository and is
# rebuilt from the release, not restored. Neither is /var/lib/private-finances,
# which holds pre-deployment dumps — derived data, and far larger than
# everything here put together.
#
# Each path is included only if it is present, so a host without one of them
# still produces a backup rather than failing on the way to the important part.
#
# `BACKUP_CONFIG_PATHS` in the service's environment file overrides the list,
# space separated, for a host that keeps these elsewhere. An unmatched glob and
# a path that does not exist are both simply skipped.
if [ -n "${BACKUP_CONFIG_PATHS:-}" ]; then
  read -r -a candidates <<<"$BACKUP_CONFIG_PATHS"
else
  candidates=(
    /etc/private-finances
    /etc/systemd/system/private-finances*.service
    /etc/systemd/system/private-finances*.timer
    /etc/systemd/system/private-finances*.timer.d
    /etc/caddy
    /etc/postgresql
  )
fi
config_paths=()
for candidate in "${candidates[@]}"; do
  [ -e "$candidate" ] && config_paths+=("$candidate")
done

# The dump is written by the service user, so it gets a directory of its own
# that the service user owns; root reads it back regardless. The parent has to
# become traversable for that to be reachable at all — `mktemp -d` makes it
# 0700 root, and a directory the service user cannot enter is a directory it
# cannot write into, whoever owns what is inside. 0711 grants the crossing and
# not the listing, so the error and result files beside it stay unreadable.
chmod 0711 "$backup_work"
install -d -o "$dump_user" -g "$dump_user" -m 700 "$backup_work/dump"

# Diagnostics stay private: pg_dump/restic errors may contain connection details.
if ! runuser -u "$dump_user" -- pg_dump --format=custom --no-owner --no-acl \
  --file="$backup_work/dump/database.dump" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"dump"}' >&2
  record failed dump '' ''
  exit 1
fi
dump_bytes=$(wc -c <"$backup_work/dump/database.dump" | tr -d ' ')
# An empty or absurdly small dump is a failure that pg_dump did not report; it
# must never be uploaded as a successful backup.
if [ "$dump_bytes" -lt 1024 ]; then
  echo '{"event":"backup_failed","stage":"dump"}' >&2
  record failed dump '' ''
  exit 1
fi

if ! restic backup --json --tag private-finances --tag database \
  --stdin --stdin-filename database.dump \
  <"$backup_work/dump/database.dump" >"$backup_work/result" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"upload"}' >&2
  record failed upload '' ''
  exit 1
fi

snapshot=''
if ! snapshot=$(read_snapshot "$backup_work/result"); then
  snapshot=''
  echo '{"event":"backup_snapshot_unparsed","part":"database"}' >&2
fi

# The configuration goes up as its own snapshot rather than being folded into
# the database one. Two reasons: restic takes either a stream or a set of paths
# in a single run and not both, and a restore usually wants one or the other —
# `restic restore latest --tag config --target /` puts the credentials back
# without unpacking a database dump beside them.
config_snapshot=''
if [ ${#config_paths[@]} -gt 0 ]; then
  if ! restic backup --json --tag private-finances --tag config \
    "${config_paths[@]}" \
    >"$backup_work/config_result" 2>"$backup_work/error"; then
    # The database is already safely uploaded at this point; the run failed at
    # its second half, and says so rather than reporting a whole lost backup.
    echo '{"event":"backup_failed","stage":"config"}' >&2
    record failed config '' ''
    exit 1
  fi
  if ! config_snapshot=$(read_snapshot "$backup_work/config_result"); then
    config_snapshot=''
    echo '{"event":"backup_snapshot_unparsed","part":"config"}' >&2
  fi
else
  echo '{"event":"backup_config_absent"}' >&2
fi

record succeeded '' "$snapshot" "$dump_bytes"
echo '{"event":"backup_completed","recorded":'"$recorded"',"config":'"$([ -n "$config_snapshot" ] && echo true || echo false)"'}'
