# Historical bank imports

PF-002/PF-003: import at least one year where the provider and consent permit it.
Runtime data and credentials stay on the server. No competing Monobank jobs per
owner: its token limit is shared across accounts. Pause regular timers during a
bulk import and restore them afterward.

The resumable operator command is:

```sh
node dist/src/backfill-cli.js monobank rodion FROM_ISO TO_ISO
node dist/src/backfill-cli.js enablebanking katya FROM_ISO TO_ISO wise
```

Use the same restricted environment as regular sync. The runner checks durable
coverage per account, skips already covered windows, and checkpoints each window.
Monobank windows are newest-first calendar months; saturated 500-record replies
are split adaptively, with shared request spacing and bounded recursion. A
saturated one-second interval remains explicitly incomplete. Authentication
failures stop that connection; partial coverage is never reported as complete.

For Enable Banking, use a fresh consent when requesting older history; account
linking in the portal alone is not the application's usable API session. Owner
credentials must match the application that created the consent. Verify account
count, requested coverage, and earliest/latest returned dates separately: an empty
complete response does not prove the account had no earlier activity.

How far back each bank will go, measured rather than assumed:

| Bank        | History served                            | How it refuses                                                                                                                                                                                                               |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wise        | Full history to date                      | —                                                                                                                                                                                                                            |
| Revolut     | About 90 days                             | —                                                                                                                                                                                                                            |
| Swedbank LV | 90 days, measured 16 September 2026       | A window of 120 days or more returns an empty first page together with a continuation key that never advances. The connector sees the repeated cursor and reports `incomplete`, which is accurate: ask for 90 days or fewer. |
| LHV EE      | Not measured yet; added 17 September 2026 | The provider lists the bank as "LHV Pank", personal accounts, redirect approval, marked beta on its side, with an approval valid for up to 180 days. Measure the history window at the first backfill and record it here.    |

Swedbank LV also reports its account currency as `XXX`, the ISO code for "no
currency", because the account holds several. Each payment carries its own
currency and that is the only one there is; see `isMultiCurrency` in
`src/connectors/enablebanking.ts`.

Operational status must record exact range, release, active units, per-account
coverage, failures, and timer restoration. No account identifiers or raw records
belong in generic logs or this repository.

## September 2026 continuation

After deploying a verified release, the one-time root command
`python3 deploy/finish-annual-import.py VERIFIED_RELEASE_SHA` waits up to three
hours for the two `pf-backfill-monobank-*` jobs started on September 12. It then
checks every freshly discovered regular account against the September 11, 2025–
September 11, 2026 import windows. It requires the previously verified local
restore checker at `/tmp/pf-restore-check.py`. No bank data leaves the server.

On success it archives/requeues old Playtomic triage, enables clear-expense auto
mode with a 1,000/day ceiling under the unchanged $10 monthly cap, and starts
`pf-categorize-year.service`. Both daily Mono timers are restored on exit, with
independent attempts. Import/coverage/recovery failure prevents automatic mode.
The continuation itself should run as a bounded transient systemd service; inspect
its journal and the categorization unit before claiming the annual pass complete.
This command is specific to this rollout, not a recurring scheduler.
