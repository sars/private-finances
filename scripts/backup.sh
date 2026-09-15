#!/usr/bin/env bash
# PostgreSQL connection uses PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSFILE.
# Restic credentials are supplied through a restricted service EnvironmentFile.
set -euo pipefail
umask 077
: "${PGDATABASE:?PGDATABASE required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE required}"
backup_work=$(mktemp -d)
trap 'rm -rf -- "$backup_work"' EXIT
# Diagnostics stay private: pg_dump/restic errors may contain connection details.
if ! pg_dump --format=custom --no-owner --no-acl --file="$backup_work/database.dump" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"dump"}' >&2
  exit 1
fi
if ! restic backup --tag private-finances --stdin --stdin-filename database.dump <"$backup_work/database.dump" >"$backup_work/result" 2>"$backup_work/error"; then
  echo '{"event":"backup_failed","stage":"upload"}' >&2
  exit 1
fi
echo '{"event":"backup_completed"}'
