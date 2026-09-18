# Encrypted off-server backups

Every copy of this household's data lives on one machine. A daily `pg_dump`
encrypted by [restic](https://restic.readthedocs.io/) and uploaded to a private
Amazon S3 bucket is what changes that. The owner chose S3, in the AWS account
they already hold; the cost at this data size is a few cents a month.

This is running. The bucket exists in `eu-north-1`, the restic repository was
initialised on 19 September 2026, the daily timer is enabled and the first
snapshot is uploaded. What is still outstanding is the proof of restore, and
until that is done a backup is a belief rather than protection.

The account section below is kept because it is how the bucket was built and
how it would be rebuilt.

## What the owner does in AWS

Five steps in the AWS console, roughly fifteen minutes. Nothing here is
reversible in a way that matters, and none of it touches the server.

**1. Choose a region.** Anything in the EU is a sensible default for a
household in Riga; `eu-north-1` (Stockholm) is the cheapest EU region. Whatever
is chosen has to be used consistently in steps 2 and 5.

**2. Create the bucket.** S3 → Create bucket. A name nobody else has taken, in
the chosen region. Leave **Block all public access** on — all four boxes. Turn
**Bucket Versioning** on. Leave default encryption at its default (SSE-S3);
restic encrypts everything before it leaves the server, so this is only a second
layer. Do not enable Object Lock: it prevents restic from managing its own
locks.

**3. Add one lifecycle rule.** Bucket → Management → Create lifecycle rule,
applied to the whole bucket, doing three things:

- expire **noncurrent** versions after 30 days,
- delete expired object delete markers,
- abort incomplete multipart uploads after 7 days.

This rule is the reason versioning is on. If the server is ever compromised and
its key used to erase the backups, the deletions become delete markers and the
real objects stay recoverable for thirty days.

**4. Create a user for the server.** IAM → Users → Create user, no console
access. Attach an **inline** policy — not a managed one — scoped to this bucket
alone, with `BUCKET` replaced by the name from step 2:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTheBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::BUCKET"
    },
    {
      "Sid": "ReadWriteObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::BUCKET/*"
    }
  ]
}
```

`DeleteObject` is there because restic removes its own lock file at the end of
every run and cannot work without it. Versioning is what makes granting it safe.
The user can reach this one bucket and nothing else in the account.

**5. Create an access key.** The user → Security credentials → Create access key
→ "Application running outside AWS". Copy both halves; the secret is shown once.

Then hand over four values — region, bucket name, access key ID, secret access
key — through the private channel, never through the repository, an issue or a
pull request.

## What the owner does outside AWS

**Invent a restic repository password and keep it.** It is not a login; it is
the encryption key for every snapshot. Losing it means losing every backup, and
no part of AWS can recover it. Generate a long random one, store it in the
password manager, and hand it over with the other four values. It ends up in a
root-only file on the server as well, but the password manager is the copy that
survives the server.

## What happens on the server

Nothing below needs the owner once the five values exist.

1. `apt-get install restic` (Ubuntu 24.04 ships 0.16.4, which is sufficient).
2. Write `/etc/private-finances/backup.env`, root-owned, mode 600, holding
   `PGHOST=/var/run/postgresql`, `PGDATABASE`, `PGUSER`, `RESTIC_REPOSITORY`
   (`s3:s3.<region>.amazonaws.com/<bucket>`), `RESTIC_PASSWORD_FILE`,
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. There is **no** `PGPASSFILE`
   and no database password: PostgreSQL authenticates this connection by peer
   over the unix socket, so the operating-system user is the credential.
   systemd reads this file as root and injects it into the backup service
   alone, which is why the AWS keys never have to be readable by anyone else.
3. The repository password lives in its own file, `RESTIC_PASSWORD_FILE`. It
   must be readable by `private-finances`, the user the service runs as —
   `chown private-finances:private-finances`, mode `400`. The containing
   directory is `root:private-finances` `0750`, so nobody else can traverse to
   it. On its own that password opens nothing: reaching the bucket also needs
   the AWS keys, which stay root-only.
4. `restic init` once, against that repository.
5. Install `private-finances-backup.service` and `.timer`, then
   `systemctl enable --now private-finances-backup.timer`.

The timer runs daily at 03:30 UTC with up to fifteen minutes of randomised
delay, and `Persistent=true` catches up a run the server slept through.

## What a run does

`scripts/backup.sh`, as the `private-finances` user:

- dumps the database with `pg_dump --format=custom --no-owner --no-acl` into a
  temporary owner-only directory that is removed on exit, success or not;
- refuses to upload a dump under 1 KiB, because an empty dump that `pg_dump`
  did not complain about is a failure, not a very small backup;
- pipes the dump into `restic backup --stdin`, tagged `private-finances`;
- records the attempt in the application's `backup_runs` table.

Diagnostics from `pg_dump` and `restic` never reach the service log: they can
carry connection details. The log carries the event and the stage it failed at,
and nothing else.

The status row goes in through `psql` reading the statement **on stdin**, never
through `--command`. `psql -c` hands its argument straight to the server, and
`:'name'` is a client-side feature, so through `-c` the placeholders reach
PostgreSQL verbatim and the statement does not parse — which is exactly what
happened on the first real run. Fed a script, psql expands each placeholder into
a correctly quoted literal, which is also what keeps a value from ever being
part of the SQL grammar. `ON_ERROR_STOP=1` is what turns a rejected statement
into a non-zero exit rather than a silent success.

## What the operations page shows

The System health page reads `backup_runs` and states one of four things:

| Shown                          | Meaning                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| **Never**                      | No off-server copy has ever been made. The opening state.     |
| **_n_ h ago**                  | The last copy succeeded that long ago.                        |
| **_n_ h ago · expected daily** | A day and the timer's delay have passed without a new one.    |
| **Failed**                     | The newest attempt failed, at the export or the upload stage. |

A newer failure outranks an older success: when the last run failed, the age of
the last good copy is no longer the thing to report, though the page still names
it. A successful upload whose status row could not be written shows as a backup
that is ageing — erring towards alarm rather than towards false comfort — and
logs `backup_status_unrecorded`.

A backup that has stopped also reaches the Home page's list of what is broken,
as a **warning** rather than a critical: nothing stops arriving when an
off-server backup fails — no import is blocked and no figure goes missing — but
the household's only protection against losing the server has gone, and the
local snapshot would go with it. A backup that has never run is deliberately not
listed there: that is configuration the owner has not finished, and Home reports
faults rather than unbuilt things.

The stored row holds a destination _label_ (`amazon-s3`), never the bucket URL:
that row travels inside the very dump that gets uploaded, and the bucket address
is private configuration. No financial content and no credentials reach the
table.

## Proving recovery, before this counts as protection

A backup nobody has restored is a belief. Before live data depends on it:
upload a synthetic snapshot, run `restic check --read-data`, restore it to a
restricted temporary folder, create a separate disposable PostgreSQL database
and restore with `pg_restore --exit-on-error --no-owner --no-acl`, then compare
transaction and audit counts and exact per-currency totals against the source.
Never restore into the active database.

Record the snapshot ID, the tested Git SHA, the timestamp and the comparison
result — without financial content. Proof is marked by
`/etc/private-finances/off-server-restore-verified`, containing exactly
`off-server-restore-verified`; the local-only marker never substitutes for it.
Repeat after migration changes and periodically thereafter.

## Retention, still deferred

The proposal remains 14 daily, 8 weekly and 12 monthly snapshots. `restic
forget --prune` is deliberately not automated and not scheduled: pruning
deletes, and nothing should delete a backup before a restore has been proven.
Until then the repository only grows, which at this data size costs very little.

The prepared timer is not proof of a successful backup, and a successful backup
is not proof of a restore.
