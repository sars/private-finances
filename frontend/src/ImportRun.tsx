/**
 * One import attempt in full: what it asked the bank for, what came back, what
 * it wrote, and where it stopped.
 *
 * The steps are the importer's own account of itself, recorded as it ran. A
 * step is a stage, a duration and a count — and for a request, the shape of the
 * path and the status that came back. Deliberately never a payload: a bank's
 * answer carries the household's payments, and this screen exists to explain a
 * failure, which needs the status and not the money.
 */
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft, CircleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AccountBadge,
  EmptyState,
  PageHeader,
  RefreshButton,
} from '@/components/finance';
import { apiGet } from '@/lib/query';
import type { AttemptStep, ImportAttemptDetail } from '../../src/import-runs';
import { asOwner, meaning, OutcomeBadge, took, when } from './ImportRuns';

const dayOnly = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Riga',
  dateStyle: 'medium',
});
function day(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? dayOnly.format(parsed) : '—';
}

/** What each stage of an import is, said once rather than in every row. */
const stageName: Record<AttemptStep['stage'], string> = {
  claim: 'Took the connection',
  request: 'Asked the bank',
  accounts: 'Listed accounts',
  balance: 'Read the balance',
  transactions: 'Fetched payments',
  commit: 'Wrote payments',
  identify: 'Recognised transfers',
  finish: 'Finished',
  error: 'Stopped',
};

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function Step({
  step,
  accountName,
}: {
  step: AttemptStep;
  accountName: (id: string) => string;
}) {
  const failed = Boolean(step.code);
  // Only what this step actually knows. A stage that took no measurable time
  // and asked for nothing — taking the connection, say — has an empty line
  // rather than a row of dashes standing in for facts it never had.
  const meta = [
    step.path,
    step.status ? `HTTP ${step.status}` : '',
    step.count === undefined
      ? ''
      : `${step.count}${step.note ? ` ${step.note}` : ''}`,
    step.ms === undefined ? '' : took(step.ms),
  ].filter(Boolean) as string[];
  return (
    <li className="flex min-h-11 items-start gap-3 px-3 py-2">
      <span
        className={
          failed
            ? 'mt-1.5 size-1.5 shrink-0 rounded-full bg-warning'
            : 'mt-1.5 size-1.5 shrink-0 rounded-full bg-border'
        }
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {stageName[step.stage]}
          {step.account ? (
            <span className="text-muted-foreground">
              {' · '}
              {accountName(step.account)}
            </span>
          ) : null}
        </p>
        {meta.length > 0 && (
          <p
            className="truncate text-xs text-muted-foreground tabular-nums"
            title={meta.join(' · ')}
          >
            {meta.join(' · ')}
          </p>
        )}
        {step.code ? (
          <p className="text-xs text-warning">
            {meaning[step.code] ?? step.code.replaceAll('_', ' ')}
            {step.retryAfterMs
              ? ` · the bank asked for ${Math.round(step.retryAfterMs / 60000)} min`
              : ''}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        +{took(step.at)}
      </p>
    </li>
  );
}

export default function ImportRun() {
  const { id } = useParams({ strict: false }) as { id: string };
  const query = useQuery({
    queryKey: ['import-run', id],
    queryFn: ({ signal }) =>
      apiGet<ImportAttemptDetail>(`/api/import-runs/${id}`, signal),
  });
  const run = query.data;
  const accountName = (accountId: string) =>
    run?.windows.find((w) => w.accountId === accountId)?.label ??
    accountId.split(':').pop()?.slice(0, 8) ??
    accountId;

  return (
    <div className="space-y-5">
      <PageHeader
        title={run ? `${run.label} · ${when(run.startedAt)}` : 'Import run'}
        actions={
          <>
            <RefreshButton />
            <Button
              variant="outline"
              size="sm"
              render={<a href="/imports/runs" />}
            >
              <ArrowLeft className="mr-2 size-3.5" />
              All runs
            </Button>
          </>
        }
      />
      {query.isPending ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : query.isError || !run ? (
        <EmptyState
          icon={CircleAlert}
          title="This run is not on record"
          text="Runs are kept for a few months; an older one has been pruned."
        />
      ) : (
        <>
          <Card className="gap-4 shadow-xs">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <AccountBadge
                    source={run.provider}
                    label={run.label}
                    owner={asOwner(run.owner)}
                    currency={null}
                  />
                  <div className="min-w-0">
                    <CardTitle className="truncate text-sm font-medium">
                      {run.label}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      asked for {day(run.from)} – {day(run.to)}
                    </p>
                  </div>
                </div>
                <OutcomeBadge run={run} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Figure label="Started" value={when(run.startedAt)} />
                <Figure label="Took" value={took(run.ms)} />
                <Figure label="Accounts" value={String(run.accounts)} />
                <Figure label="Payments written" value={String(run.changed)} />
              </div>
              {run.errorCode && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs leading-relaxed">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                  <p>
                    {meaning[run.errorCode] ??
                      'It stopped for a reason this screen cannot name.'}
                    {' · '}
                    {run.errorCode.replaceAll('_', ' ')}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">What it did</h2>
            {run.steps.length ? (
              <ul className="divide-y rounded-lg border">
                {run.steps.map((step, index) => (
                  <Step
                    key={`${step.stage}:${step.at}:${index}`}
                    step={step}
                    accountName={accountName}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                This run recorded no steps. Runs from before this record existed
                have none.
              </p>
            )}
          </section>

          {run.windows.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-base font-semibold">What it covered</h2>
              <ul className="divide-y rounded-lg border">
                {run.windows.map((window) => (
                  <li
                    key={window.accountId}
                    className="flex min-h-11 items-center gap-3 px-3 py-2"
                  >
                    <AccountBadge
                      source={run.provider}
                      label={window.label ?? window.accountId}
                      currency={window.currency}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {window.label ?? 'Account not registered'}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {day(window.from)} – {day(window.to)}
                      </p>
                    </div>
                    <p className="text-sm font-medium tabular-nums">
                      {window.changed ? `+${window.changed}` : '0'}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="text-xs leading-relaxed text-muted-foreground">
                A covered window is a span this account is known to have been
                read for. Whether the whole history is present is a separate
                question.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
