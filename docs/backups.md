# Encrypted backups

Prepared, not enabled. Owner-selected destination: private Amazon S3 bucket in the existing AWS account.
Use restic with the bucket region’s S3 endpoint. Official setup reference:
https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html

The restricted /etc/private-finances/backup.env supplies PGHOST, PGPORT, PGUSER,
PGDATABASE, PGPASSFILE, RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE,
AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Store the restic recovery password
in the owner's password manager as well as its server secret file. The server
credential should be limited to this backup bucket. Never commit these values.

Initialize the restic repository once with the verified private bucket URL.
The daily timer runs pg_dump followed by an encrypted restic upload. Dump files
exist only in a temporary owner-only directory, removed on exit. An unsuccessful
dump cannot upload an empty successful backup. Credentials and raw diagnostics
are excluded from service logs. PostgreSQL client version must support the server.

Before live imports, prove recovery: upload a synthetic database snapshot, run
restic check --read-data, restore the snapshot to a restricted temporary folder,
create a separate disposable PostgreSQL database, restore with pg_restore
--exit-on-error --no-owner --no-acl, and compare transaction/audit counts and exact
per-currency totals with the source. Never restore into the active database.
Record snapshot ID, tested Git SHA, timestamp and comparison result without
financial content. Repeat after migration changes and periodically thereafter.

Retention proposal: 14 daily, 8 weekly, 12 monthly snapshots. Deletion/pruning
is not automated yet; confirm retention and prove restore first. Backup failure
and age still need wiring into dashboard/alerts. The prepared timer alone is
not proof of a successful backup or restore.
