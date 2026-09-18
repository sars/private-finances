import { useUrlField } from './lib/navigation';
import { money } from './lib/format';
import {
  useSession,
  invalidateFinancialData,
  useRefreshSignal,
} from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, CircleAlert, FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Choice, Field, PageHeader, RefreshButton } from '@/components/finance';
import type { ReportSnapshot } from '../../src/reports';

type Scope = 'all' | 'rodion' | 'katya';
const scopeName = (scope: string) =>
  scope === 'all' ? 'Together' : scope === 'rodion' ? 'Rodion' : 'Katya';
function periodLabel(snapshot: ReportSnapshot) {
  const period = snapshot.report.period;
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: period.timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${format.format(new Date(period.from))} – ${format.format(new Date(Date.parse(period.to) - 1))}`;
}
export default function Reports() {
  const { currency: displayCurrency } = useDisplayCurrency();
  const session = useSession();
  const [requestedScope, setScope] = useUrlField(
    'owner',
    session.data?.actor ?? '',
  );
  const scope = ['all', 'rodion', 'katya'].includes(requestedScope)
    ? requestedScope
    : (session.data?.actor ?? '');
  const [requestedPeriod, setPeriod] = useUrlField('period', 'week');
  const period = requestedPeriod === 'month' ? 'month' : 'week';
  const csrf = session.data?.csrf ?? '';
  const [reports, setReports] = useState<ReportSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetchError, setError] = useState('');
  const error = session.error?.message || fetchError;
  const [notice, setNotice] = useState('');
  const refresh = useRefreshSignal();
  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await fetch(`/api/reports?owner=${scope}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok)
          throw new Error('We couldn’t load your reports. Please try again.');
        const data = await response.json();
        if (!Array.isArray(data.reports))
          throw new Error(
            'The report response was incomplete. Please try again.',
          );
        if (!controller.signal.aborted) setReports(data.reports);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load reports.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [scope, refresh]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!scope || !csrf || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/reports', {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({ csrf, owner: scope, period }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? 'Your session changed. Reload before creating a report.'
            : 'We couldn’t refresh this report. Please try again.',
        );
      await invalidateFinancialData();
      setNotice('Report refreshed. Unchanged records keep the same version.');
      void invalidateFinancialData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create report.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="Reports"
        description="Weekly and monthly snapshots, with every revision kept."
        actions={<RefreshButton />}
      />
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4"
      >
        <Field label="Account owner" htmlFor="report-owner">
          <Choice
            id="report-owner"
            className="w-full sm:w-40"
            value={scope}
            onChange={(value) => {
              setScope(value as Scope);
              setNotice('');
            }}
            options={(['all', 'rodion', 'katya'] as const).map((owner) => ({
              value: owner,
              label: scopeName(owner),
            }))}
            placeholder="Loading owner…"
            disabled={saving || !csrf}
          />
        </Field>
        <Field label="Create or refresh" htmlFor="report-period">
          <Choice
            id="report-period"
            className="w-full sm:w-52"
            value={period}
            onChange={(v) => setPeriod(v as typeof period)}
            options={[
              { value: 'week', label: 'Previous calendar week' },
              { value: 'month', label: 'Previous calendar month' },
            ]}
            disabled={saving}
          />
        </Field>
        <Button
          type="submit"
          className="w-full sm:w-auto"
          disabled={!csrf || !scope || saving}
        >
          <Plus />
          {saving ? 'Creating…' : 'Create report'}
        </Button>
      </form>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <CalendarDays className="mt-0.5 size-4 shrink-0" />
        Calendar periods use Europe/Riga. Currencies remain separate; missing
        historical rates are never replaced by current rates. These saved
        snapshots keep their original currencies.
      </p>
      <a
        href={`/analytics?display=${displayCurrency}&owner=${scope || 'all'}`}
        className="inline-flex text-sm font-medium text-primary underline underline-offset-4"
      >
        Open live spending analytics in {displayCurrency}
      </a>
      {notice && (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <Card>
          <CardContent className="space-y-3 py-5">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() =>
                scope ? void invalidateFinancialData() : void session.refetch()
              }
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
      {loading ? (
        <div role="status" aria-label="Loading reports" className="space-y-4">
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-52 rounded-lg" />
        </div>
      ) : !reports.length && !error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <FileText className="size-8 text-muted-foreground" />
            <h2 className="font-semibold">No reports for this owner yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Create a report for the previous calendar week or month. Missing
              imports remain visible as incomplete coverage.
            </p>
          </CardContent>
        </Card>
      ) : (
        !error && (
          <div className="space-y-5">
            {reports.map((snapshot) => (
              <Card key={snapshot.id} className="shadow-xs">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <CardTitle className="text-base">
                      {snapshot.report.period.kind === 'week'
                        ? 'Weekly'
                        : 'Monthly'}{' '}
                      report · {scopeName(snapshot.report.owner)}
                    </CardTitle>
                    <Badge variant="outline">Version {snapshot.version}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {periodLabel(snapshot)}{' '}
                    <span className="text-xs">
                      ({snapshot.report.period.timeZone})
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.report.transactionCount} imported transactions ·
                    Created{' '}
                    {new Intl.DateTimeFormat('en-GB', {
                      timeZone: 'Europe/Riga',
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(snapshot.createdAt))}{' '}
                    (Riga)
                  </p>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs leading-relaxed">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                    <span>
                      {snapshot.report.incompleteness.unresolvedCount}{' '}
                      unresolved · {snapshot.report.incompleteness.pendingCount}{' '}
                      pending. Bank import coverage is unverified; these figures
                      may be incomplete.
                    </span>
                  </div>
                  {snapshot.report.byCurrency.length ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {snapshot.report.byCurrency.map((row) => (
                        <section
                          key={row.currency}
                          className="min-w-0 rounded-lg border p-4"
                        >
                          <p className="text-xs font-medium text-muted-foreground">
                            Confirmed personal spending · {row.currency}
                          </p>
                          <p className="mt-2 break-all text-xl font-semibold tabular-nums">
                            {money(row.personalExpenseMinor, row.currency)}
                          </p>
                          <dl className="mt-4 space-y-2 text-xs">
                            <div className="flex justify-between gap-3">
                              <dt className="text-muted-foreground">
                                Unresolved
                              </dt>
                              <dd className="break-all text-right tabular-nums">
                                {money(
                                  row.unresolvedOutflowMinor,
                                  row.currency,
                                )}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                              <dt className="text-muted-foreground">Pending</dt>
                              <dd className="break-all text-right tabular-nums">
                                {money(row.pendingOutflowMinor, row.currency)}
                              </dd>
                            </div>
                          </dl>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No imported transactions in this period. This does not
                      prove zero spending.
                    </p>
                  )}
                  {snapshot.report.byPattern && (
                    <details className="rounded-lg border p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        Routine and exceptional spending
                      </summary>
                      <p className="mt-3 text-xs text-muted-foreground">
                        Unreviewed payments stay separate until you choose a
                        spending pattern.
                      </p>
                      <div className="mt-3 space-y-2">
                        {snapshot.report.byPattern.flatMap((group) =>
                          group.byCurrency.map((row) => (
                            <div
                              key={group.pattern + row.currency}
                              className="flex flex-wrap justify-between gap-2 text-sm"
                            >
                              <span>
                                {group.pattern === 'routine'
                                  ? 'Routine'
                                  : group.pattern === 'exceptional'
                                    ? 'Exceptional'
                                    : 'Not reviewed'}
                              </span>
                              <span className="tabular-nums">
                                {money(row.personalExpenseMinor, row.currency)}
                              </span>
                            </div>
                          )),
                        )}
                      </div>
                    </details>
                  )}
                  <details className="rounded-lg border p-4">
                    <summary className="cursor-pointer text-sm font-medium">
                      Category breakdown ({snapshot.report.byCategory.length})
                    </summary>
                    <div className="mt-4 space-y-3">
                      {snapshot.report.byCategory.map((row) => (
                        <div
                          key={JSON.stringify([
                            row.owner,
                            row.currency,
                            row.category,
                          ])}
                          className="flex flex-wrap justify-between gap-2 text-sm"
                        >
                          <div className="min-w-0 break-words">
                            <p>{row.category}</p>
                            <p className="text-xs text-muted-foreground">
                              {scopeName(row.owner)}
                            </p>
                          </div>
                          <p className="break-all text-right tabular-nums">
                            {money(row.personalExpenseMinor, row.currency)}
                          </p>
                        </div>
                      ))}
                      {!snapshot.report.byCategory.length && (
                        <p className="text-sm text-muted-foreground">
                          No classified personal expenses in this snapshot.
                        </p>
                      )}
                    </div>
                  </details>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}
