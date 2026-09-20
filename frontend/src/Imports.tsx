/**
 * Every bank import in one place: which connections exist, what each last did,
 * how much it brought in, what its accounts hold, and how long its approval
 * lasts. A reading of the importer's own record (`/api/imports`), so a
 * connection that has quietly stopped shows as a last run growing old.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AccountBadge,
  EmptyState,
  PageHeader,
  RefreshButton,
} from '@/components/finance';
import { apiGet } from '@/lib/query';
import type { Owner } from '@/lib/account-visuals';
import { connectionLabel } from '@/lib/account-visuals';
import type {
  ImportConnection,
  ImportRun,
  ImportStatus,
} from '../../src/import-status';

const DAY = 86400000;

const advice: Record<string, string> = {
  auth: 'The bank no longer accepts our credentials. Reconnect this bank.',
  consent: 'The approval has expired or was revoked. Approve this bank again.',
  // Neither of these says "the next scheduled attempt retries" any more,
  // because for a rate limit it does not: the connection rests for half a day
  // and the timers in between exit without asking the bank anything. The hour
  // it resumes is stated separately, from what the scheduler wrote down.
  rate_limit: 'The bank asked us to slow down, so this connection is resting.',
  transient:
    'The bank was temporarily unavailable. It backs off and tries again.',
  schema:
    'The bank returned data in a shape we do not accept. Needs a look before retrying.',
  incomplete:
    'The bank answered only in part. That window is not counted as imported.',
  sync_failed:
    'The import stopped for a reason it could not classify. Needs a look.',
};

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Riga',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateOnly = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Riga',
  dateStyle: 'medium',
});
function when(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? dateTime.format(parsed) : '—';
}
function day(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? dateOnly.format(parsed) : '—';
}
/** "12 min ago", "3 h ago", "2 days ago": how stale a run is, at a glance. */
function ago(value: string | null, now: number) {
  const parsed = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return null;
  const minutes = Math.max(0, Math.round((now - parsed) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
const clockOnly = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Riga',
  hour: '2-digit',
  minute: '2-digit',
});
/**
 * A moment still ahead, as a wall clock the owner can wait for: "14:24",
 * "tomorrow at 02:10". Null once it has passed, so a stale mark left by a
 * scheduler that has since stopped never claims a bank is about to wake.
 */
function upcoming(value: string | null, now: number): string | null {
  const parsed = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= now) return null;
  const clock = clockOnly.format(parsed);
  const sameDay = dateOnly.format(parsed) === dateOnly.format(now);
  if (sameDay) return clock;
  const tomorrow = dateOnly.format(now + DAY) === dateOnly.format(parsed);
  return tomorrow ? `tomorrow at ${clock}` : `${day(value)} at ${clock}`;
}
function asOwner(owner: string): Owner | null {
  return owner === 'rodion' || owner === 'katya' ? owner : null;
}
function ownerName(owner: string) {
  return owner === 'rodion' ? 'Rodion' : owner === 'katya' ? 'Katya' : owner;
}

type Health = 'ok' | 'waiting' | 'attention';

/** One verdict per connection, from what the record says. */
function verdict(
  c: ImportConnection,
  now: number,
): { health: Health; text: string } {
  if (c.consent && Date.parse(c.consent.expiresAt) <= now)
    return { health: 'attention', text: 'Approval expired' };
  if (c.state === 'never_run')
    return { health: 'waiting', text: 'Waiting for its first import' };
  if (c.state === 'failed')
    return { health: 'attention', text: 'Last import failed' };
  if (c.state === 'running') return { health: 'ok', text: 'Importing now' };
  const last = c.lastSuccessAt ? Date.parse(c.lastSuccessAt) : NaN;
  if (!Number.isFinite(last))
    return { health: 'waiting', text: 'No complete run yet' };
  if (now - last > DAY)
    return { health: 'attention', text: 'No complete run for over a day' };
  return { health: 'ok', text: 'Up to date' };
}

function HealthBadge({ health, text }: { health: Health; text: string }) {
  return (
    <Badge
      variant="outline"
      className={
        health === 'attention'
          ? 'text-warning'
          : health === 'ok'
            ? 'text-positive'
            : 'text-muted-foreground'
      }
    >
      {text}
    </Badge>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function ConnectionCard({
  connection: c,
  now,
}: {
  connection: ImportConnection;
  now: number;
}) {
  const state = verdict(c, now);
  const consentDays = c.consent
    ? Math.ceil((Date.parse(c.consent.expiresAt) - now) / DAY)
    : null;
  const waiting = upcoming(c.nextAttemptAt, now);
  /**
   * A wait the bank imposed, as opposed to the ordinary polling interval.
   *
   * The scheduler's reason is the better evidence, but it is absent for a wait
   * begun by a release older than that record — which is exactly the case of
   * the rate limit that prompted all this. So the connection's own last error
   * counts too: it is why the wait was set, even when the wait cannot say so.
   */
  const backedOff = new Set(['rate_limit', 'transient']);
  const backingOff =
    backedOff.has(c.retryReason ?? '') ||
    (c.retryReason === null && backedOff.has(c.errorCode ?? ''));
  return (
    <Card className="gap-4 shadow-xs">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <AccountBadge
              source={c.provider}
              label={c.label}
              owner={asOwner(c.owner)}
              currency={null}
            />
            <div className="min-w-0">
              <CardTitle className="truncate text-sm font-medium">
                {c.label}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {ownerName(c.owner)}
                {c.unrecognised ? ' · this release cannot name this bank' : ''}
              </p>
            </div>
          </div>
          <HealthBadge {...state} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Last run" value={ago(c.lastSuccessAt, now) ?? '—'} />
          <Figure label="Runs, 24 h" value={String(c.runs24h)} />
          <Figure label="Changed, 7 d" value={String(c.changed7d)} />
          <Figure label="Changed, 30 d" value={String(c.changed30d)} />
        </div>
        {c.lastSuccessAt && (
          <p className="text-xs text-muted-foreground">
            Last complete run {when(c.lastSuccessAt)}
            {c.lastRunAt && c.lastRunAt !== c.lastSuccessAt
              ? ` · last window ${when(c.lastRunAt)}`
              : ''}
          </p>
        )}
        {waiting && (
          // Only a wait the bank itself caused is worth colouring. An ordinary
          // polling interval is not, and neither is a wait whose reason we do
          // not have — one set by a release older than this record, or cleared
          // by hand on the server. Saying "resting" in warning ink about a
          // connection we cannot explain claims trouble we have not found.
          <p
            className={
              backingOff
                ? 'text-xs text-warning'
                : 'text-xs text-muted-foreground'
            }
          >
            {backingOff
              ? `Resting until ${waiting}; nothing is asked of the bank before then`
              : `Next attempt ${waiting}`}
          </p>
        )}
        {c.consent && consentDays !== null && (
          <p
            className={
              consentDays <= 2
                ? 'text-xs text-warning'
                : 'text-xs text-muted-foreground'
            }
          >
            {consentDays <= 0
              ? `Approval expired ${day(c.consent.expiresAt)}`
              : `Approval valid until ${day(c.consent.expiresAt)} (${consentDays} ${consentDays === 1 ? 'day' : 'days'})`}
            {c.consent.status !== 'authorized' ? ` · ${c.consent.status}` : ''}
          </p>
        )}
        {c.errorCode && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs leading-relaxed">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              {advice[c.errorCode] ??
                'The import needs a look before it is retried.'}
            </p>
          </div>
        )}
        {c.accounts.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {c.accounts.map((a) => (
              <li
                key={a.accountId}
                className="flex min-h-11 items-center gap-3 px-3 py-2"
              >
                <AccountBadge
                  source={c.provider}
                  label={a.label}
                  currency={a.currency}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={a.label}>
                    {a.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.latestBookedAt
                      ? `latest ${day(a.latestBookedAt)}`
                      : 'no payments yet'}
                    {a.purpose === 'unreviewed' ? ' · purpose not set' : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium tabular-nums">
                    {a.transactions}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {a.changed7d ? `+${a.changed7d} this week` : 'quiet week'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No account has been imported through this connection yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RunsTable({ runs, now }: { runs: ImportRun[]; now: number }) {
  const label = (run: ImportRun) =>
    run.label ??
    connectionLabel(run.connection.split(':').slice(0, 2).join(':'));
  return (
    <>
      <ul className="divide-y rounded-lg border sm:hidden">
        {runs.map((run) => (
          <li
            key={`${run.completedAt}:${run.accountId}`}
            className="flex min-h-11 items-center gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={label(run)}>
                {label(run)}
              </p>
              <p className="text-xs text-muted-foreground">
                {ago(run.completedAt, now)} · {day(run.from)} – {day(run.to)}
              </p>
            </div>
            <p className="text-sm font-medium tabular-nums">
              {run.changed ? `+${run.changed}` : '0'}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden rounded-lg border sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Completed</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Changed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={`${run.completedAt}:${run.accountId}`}>
                <TableCell className="text-muted-foreground tabular-nums">
                  {when(run.completedAt)}
                </TableCell>
                <TableCell className="max-w-56 truncate" title={label(run)}>
                  {label(run)}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {day(run.from)} – {day(run.to)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {run.changed}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * How long ago this page last asked the server, counting up while you watch.
 *
 * Refreshing this screen re-reads the importer's record; it does not go to the
 * banks, which have their own schedule. So when nothing has changed since the
 * last look, a refresh leaves every figure exactly as it was, and without this
 * line there is nothing on the screen to show it happened at all.
 */
function LastChecked({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  return (
    <>
      checked{' '}
      {seconds < 10
        ? 'just now'
        : seconds < 60
          ? `${seconds} s ago`
          : (ago(at, Date.now()) ?? 'just now')}
    </>
  );
}

export default function Imports() {
  const status = useQuery({
    queryKey: ['imports'],
    queryFn: ({ signal }) => apiGet<ImportStatus>('/api/imports', signal),
    refetchInterval: 60000,
  });
  const data = status.data;
  const now = data ? Date.parse(data.generatedAt) : Date.now();
  const attention = data
    ? data.connections.filter((c) => verdict(c, now).health === 'attention')
    : [];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Bank imports"
        description="Every connection: what it last did, what it brought in, and how long its approval lasts."
        actions={
          <>
            <RefreshButton />
            <Button
              variant="outline"
              size="sm"
              render={<a href="/connections" />}
            >
              Approvals
              <ArrowUpRight className="ml-2 size-3.5" />
            </Button>
          </>
        }
      />
      {status.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      ) : status.isError || !data ? (
        <EmptyState
          icon={CircleAlert}
          title="Import status is unavailable"
          text="This does not confirm that imports are healthy. Please retry."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {data.connections.length} connections
            {attention.length
              ? ` · ${attention.length} ${attention.length === 1 ? 'needs' : 'need'} attention`
              : ' · all up to date'}
            {' · '}
            {data.connections.reduce((n, c) => n + c.changed7d, 0)} payments
            changed in the last 7 days
            {' · '}
            <LastChecked at={data.generatedAt} />
          </p>
          <section className="grid gap-4 md:grid-cols-2">
            {data.connections.map((c) => (
              <ConnectionCard key={c.connection} connection={c} now={now} />
            ))}
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Recent runs</h2>
              <Button
                variant="outline"
                size="sm"
                render={<a href="/imports/runs" />}
              >
                All runs
                <ArrowUpRight className="ml-2 size-3.5" />
              </Button>
            </div>
            {data.runs.length ? (
              <RunsTable runs={data.runs} now={now} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No import window has completed yet.
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              These are the windows that completed. A run that failed, or that
              never reached the bank, is on the all-runs screen — which is where
              a connection in trouble shows what happened.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
