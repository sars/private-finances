/**
 * Every attempt to import a bank, newest first — the failures included.
 *
 * The Imports screen answers "is each bank healthy"; this one answers "what
 * has actually been happening". They read different records on purpose. The
 * card on Imports is built from completed windows, which a failing bank never
 * writes, so the bank most worth looking at was the one least visible. Here a
 * row exists for every attempt, and the ones that went wrong are the ones the
 * filters are for.
 *
 * The list is the same shape as the payments list: a page at a time, cut by
 * the server with a keyset, the next page asked for as the end comes near.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useUrlField } from './lib/navigation';
import { ArrowUpRight, CircleAlert, ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Choice,
  EmptyState,
  FilterBar,
  Field,
  PageHeader,
  PagedList,
  RefreshButton,
  AccountBadge,
} from '@/components/finance';
import { apiGet } from '@/lib/query';
import type { Owner } from '@/lib/account-visuals';
import type { ImportAttempt, ImportRunPage } from '../../src/import-runs';
import type { ImportStatus } from '../../src/import-status';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Riga',
  dateStyle: 'medium',
  timeStyle: 'short',
});
export function when(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? dateTime.format(parsed) : '—';
}
/** "1.2 s", "340 ms", "2 min": how long a run or a request took. */
export function took(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}
export function asOwner(owner: string): Owner | null {
  return owner === 'rodion' || owner === 'katya' ? owner : null;
}

/** What an error code means, in the owner's terms rather than the bank's. */
export const meaning: Record<string, string> = {
  auth: 'The bank refused our credentials',
  consent: 'The approval had expired or been revoked',
  rate_limit: 'The bank asked us to slow down',
  transient: 'The bank was briefly unreachable',
  schema: 'The bank answered in a shape we do not accept',
  incomplete: 'The bank answered only in part',
  sync_failed: 'It stopped for a reason it could not classify',
  sync_lease_lost: 'Another run took the connection over',
  sync_already_running: 'A run was already in progress',
};

export function OutcomeBadge({ run }: { run: ImportAttempt }) {
  if (run.outcome === 'running')
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Running
      </Badge>
    );
  if (run.outcome === 'failed')
    return (
      <Badge variant="outline" className="text-warning">
        {run.errorCode ? run.errorCode.replaceAll('_', ' ') : 'failed'}
      </Badge>
    );
  return (
    <Badge
      variant="outline"
      className={run.changed ? 'text-positive' : 'text-muted-foreground'}
    >
      {run.changed ? `+${run.changed}` : 'no change'}
    </Badge>
  );
}

function Row({ run }: { run: ImportAttempt }) {
  return (
    <a
      href={`/imports/runs/${run.id}`}
      className="flex min-h-11 items-center gap-3 px-3 py-2 hover:bg-muted/50"
    >
      <AccountBadge
        source={run.provider}
        label={run.label}
        owner={asOwner(run.owner)}
        currency={null}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={run.label}>
          {run.label}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {when(run.startedAt)} · {took(run.ms)}
          {run.accounts ? ` · ${run.accounts} accounts` : ''}
        </p>
      </div>
      <OutcomeBadge run={run} />
    </a>
  );
}

const OUTCOMES = [
  { value: '', label: 'Any outcome' },
  { value: 'failed', label: 'Failed' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'running', label: 'Running' },
];
const SPANS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '', label: 'Everything kept' },
];

export default function ImportRuns() {
  // The filters live in the URL, so a view worth keeping is a link worth
  // sending — "Swedbank, failed, last 30 days" survives a reload and a share.
  const [connection, setConnection] = useUrlField('connection', '');
  const [outcome, setOutcome] = useUrlField('outcome', '');
  const [span, setSpan] = useUrlField('span', '7');

  // The bank list comes from the same record the Imports screen reads, so the
  // filter offers exactly the connections that exist rather than a hardcoded
  // list that a newly added bank would fall outside of.
  const status = useQuery({
    queryKey: ['imports'],
    queryFn: ({ signal }) => apiGet<ImportStatus>('/api/imports', signal),
  });
  const banks = useMemo(
    () => [
      { value: '', label: 'All banks' },
      ...(status.data?.connections ?? []).map((c) => ({
        value: c.connection,
        label: `${c.label} · ${c.owner === 'rodion' ? 'Rodion' : c.owner === 'katya' ? 'Katya' : c.owner}`,
      })),
    ],
    [status.data],
  );

  const from = span
    ? new Date(Date.now() - Number(span) * 86400000).toISOString()
    : '';
  const query = useInfiniteQuery({
    queryKey: ['import-runs', connection, outcome, span],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ImportRunPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (connection) params.set('connection', connection);
      if (outcome) params.set('outcome', outcome);
      if (from) params.set('from', from);
      if (pageParam) params.set('cursor', pageParam);
      return apiGet<ImportRunPage>(
        '/api/import-runs?' + params.toString(),
        signal,
      );
    },
  });
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const failed = runs.filter((run) => run.outcome === 'failed').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import runs"
        description="Every attempt to read a bank, including the ones that failed."
        actions={
          <>
            <RefreshButton />
            <Button variant="outline" size="sm" render={<a href="/imports" />}>
              Connections
              <ArrowUpRight className="ml-2 size-3.5" />
            </Button>
          </>
        }
      />
      <FilterBar>
        <Field label="Bank" hideLabel>
          <Choice value={connection} onChange={setConnection} options={banks} />
        </Field>
        <Field label="Outcome" hideLabel>
          <Choice value={outcome} onChange={setOutcome} options={OUTCOMES} />
        </Field>
        <Field label="Period" hideLabel>
          <Choice value={span} onChange={setSpan} options={SPANS} />
        </Field>
      </FilterBar>
      <PagedList
        items={runs}
        keyOf={(run) => run.id}
        renderRow={(run) => <Row run={run} />}
        estimateSize={60}
        loading={query.isPending}
        hasMore={Boolean(query.hasNextPage)}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        empty={
          query.isError ? (
            <EmptyState
              icon={CircleAlert}
              title="The run record is unavailable"
              text="This does not mean the imports are healthy. Please retry."
            />
          ) : (
            <EmptyState
              icon={ListChecks}
              title="No runs in this period"
              text="Widen the period, or clear the filters to see everything kept."
            />
          )
        }
        footer={
          <>
            {total} {total === 1 ? 'run' : 'runs'}
            {failed ? ` · ${failed} failed on this page` : ''}
          </>
        }
      />
    </div>
  );
}
