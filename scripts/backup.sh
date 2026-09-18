#!/usr/bin/env bash
# Daily encrypted off-server backup: pg_dump piped into a restic repository
# held in a private Amazon S3 bucket. See docs/backups.md.
#
# PostgreSQL connection uses PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSFILE.
# Restic credentials are supplied through a restricted service EnvironmentFile.
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
  if psql --no-psqlrc --quiet --tuples-only --no-align \
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

# Diagnostics stay private: pg_dump/restic errors may contain connection details.
if ! pg_dump --format=custom --no-owner --no-acl --file="$backup_work/database.dump" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"dump"}' >&2
  record failed dump '' ''
  exit 1
fi
dump_bytes=$(wc -c <"$backup_work/database.dump" | tr -d ' ')
# An empty or absurdly small dump is a failure that pg_dump did not report; it
# must never be uploaded as a successful backup.
if [ "$dump_bytes" -lt 1024 ]; then
  echo '{"event":"backup_failed","stage":"dump"}' >&2
  record failed dump '' ''
  exit 1
fi

if ! restic backup --json --tag private-finances --stdin --stdin-filename database.dump \
  <"$backup_work/database.dump" >"$backup_work/result" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"upload"}' >&2
  record failed upload '' ''
  exit 1
fi

# restic --json writes one JSON object per line and ends with a summary naming
# the snapshot it created. A missing summary means the upload cannot be proven,
# so the run is recorded without a snapshot id rather than claimed as verified.
snapshot=''
if ! snapshot=$(python3 - "$backup_work/result" <<'PY'
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
); then
  snapshot=''
  echo '{"event":"backup_snapshot_unparsed"}' >&2
fi

record succeeded '' "$snapshot" "$dump_bytes"
echo '{"event":"backup_completed","recorded":'"$recorded"'}'
