import LlmBudget from './LlmBudget';
import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  Database,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/finance';
import { DecisionCoverage } from '@/components/decision-coverage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { CredentialHealth } from '../../src/credential-health';

type Workflow = {
  availability: 'available' | 'unavailable';
  counts: Record<string, number> | null;
  total: number | null;
  latestCreatedAt: string | null;
  oldestOutstandingCreatedAt: string | null;
  expiredSendingCount: number | null;
};
const workflowLabels: Record<string, string> = {
  telegramQuestions: 'Telegram questions',
  telegramReplies: 'Telegram replies',
  replyProposals: 'Reply suggestions',
  replyReceipts: 'Confirmation receipts',
  reportDelivery: 'Report delivery',
  classifier: 'AI suggestions',
  transactionTriage: 'Transaction interpretation',
  credentialReminders: 'Key replacement reminders',
};
type Health = {
  workflows?: Record<string, Workflow>;
  database: string;
  source: string;
  freshness: string;
  lastSuccessAt: string | null;
  jobs: Array<{ state: string; count: number }>;
  bankConnections: Array<{
    connection: string;
    state: string;
    last_success_at: string | null;
    error_code: string | null;
  }>;
  credentials: CredentialHealth[];
};
const advice: Record<string, string> = {
  auth: 'Reconnect this bank before retrying.',
  consent: 'Bank consent has expired or was revoked. Reconnect this bank.',
  rate_limit:
    'The bank asked us to slow down. A later scheduled attempt can retry.',
  transient:
    'The bank is temporarily unavailable. A later scheduled attempt can retry.',
  schema:
    'The bank returned unexpected data. Review is needed before importing.',
  incomplete:
    'The bank response was incomplete. No completion is claimed for the failed account window.',
  sync_failed:
    'Import needs review. Previously completed account windows remain saved.',
};
const labels: Record<string, string> = {
  unknown_expiry: 'Expiry unknown',
  invalid_expiry: 'Check expiry setting',
  healthy: 'Within configured validity',
  expiring: 'Replacement due soon',
  expires_today: 'Expires today',
  expired: 'Configured expiry passed',
};
function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Riga',
      }).format(parsed) + ' (Riga)'
    : 'Date unavailable';
}
export default function Operations() {
  const [health, setHealth] = useState<Health>();
  const [release, setRelease] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [checkedAt, setCheckedAt] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const responses = await Promise.all(
          ['/api/ops', '/api/bootstrap'].map((path) =>
            fetch(path, {
              signal: controller.signal,
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
            }),
          ),
        );
        if (responses.some((r) => !r.ok))
          throw new Error(
            responses.some((r) => r.status === 401)
              ? 'Your session needs attention. Reload to sign in again.'
              : 'System health is unavailable. This does not confirm that the database or imports are healthy.',
          );
        const [data, session] = await Promise.all(
          responses.map((r) => r.json()),
        );
        if (
          !Array.isArray(data.bankConnections) ||
          !Array.isArray(data.jobs) ||
          !Array.isArray(data.credentials)
        )
          throw new Error(
            'Health information was incomplete. Please try again.',
          );
        if (!controller.signal.aborted) {
          setHealth(data);
          setRelease(session.release);
          setCheckedAt(new Date().toISOString());
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Unable to load health information.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <PageHeader
        title="System health"
        description="Bank imports, access expiry and the status of your workspace."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />
      <LlmBudget refresh={refresh} />
      <DecisionCoverage />
      {loading ? (
        <div
          role="status"
          aria-label="Loading system health"
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
          <Skeleton className="h-60 rounded-lg" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="space-y-3 py-8">
            <CircleAlert className="size-7 text-muted-foreground" />
            <h2 className="font-semibold">Health information unavailable</h2>
            <p role="alert" className="text-sm text-muted-foreground">
              {error}
            </p>
            <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        health && (
          <>
            <p className="text-xs text-muted-foreground">
              Checked {date(checkedAt)}. Refresh to check for changes.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="gap-3 shadow-xs">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Database className="size-4 text-primary" />
                    Application database
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xl font-semibold capitalize">
                    {health.database}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {health.database === 'ready'
                      ? 'Connected and responding'
                      : 'Database status needs review'}
                  </p>
                </CardContent>
              </Card>
              <Card className="gap-3 shadow-xs">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Activity className="size-4 text-primary" />
                    Running release
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p
                    className="break-all font-mono text-xl font-semibold"
                    title={release}
                  >
                    {release.slice(0, 7) || 'Unavailable'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use this reference when reporting a problem.
                  </p>
                </CardContent>
              </Card>
            </div>
            <section className="space-y-3" aria-label="Workflow activity">
              <h2 className="text-base font-semibold">Workflow activity</h2>
              <p className="text-xs text-muted-foreground">
                Delivery and processing records. Uncertain deliveries need
                review before retrying.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(health.workflows ?? {}).map(([key, flow]) => (
                  <Card key={key} className="gap-0 py-0 shadow-xs">
                    <CardContent className="space-y-3 p-4">
                      <h3 className="text-sm font-medium">
                        {workflowLabels[key] ?? key}
                      </h3>
                      {flow.availability === 'unavailable' ? (
                        <p className="text-sm text-muted-foreground">
                          Monitoring unavailable
                        </p>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(flow.counts ?? {})
                              .filter(([, count]) => count > 0)
                              .map(([state, count]) => (
                                <Badge
                                  key={state}
                                  variant="outline"
                                  className={
                                    ['failed', 'uncertain'].includes(state)
                                      ? 'border-warning/40 text-warning'
                                      : ''
                                  }
                                >
                                  {count} {state.replaceAll('_', ' ')}
                                </Badge>
                              ))}
                            {flow.total === 0 && (
                              <span className="text-xs text-muted-foreground">
                                No records yet
                              </span>
                            )}
                          </div>
                          {Boolean(flow.expiredSendingCount) && (
                            <p role="status" className="text-xs text-warning">
                              {flow.expiredSendingCount} interrupted sending
                              attempts need attention.
                            </p>
                          )}
                          {flow.oldestOutstandingCreatedAt && (
                            <p className="text-xs text-muted-foreground">
                              Oldest outstanding record:{' '}
                              {date(flow.oldestOutstandingCreatedAt)}
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Bank imports</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  render={<a href="/imports" />}
                >
                  All imports and statistics
                  <ArrowUpRight className="ml-2 size-3.5" />
                </Button>
              </div>
              {health.bankConnections.length ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {health.bankConnections.map((connection) => {
                    const last = connection.last_success_at
                      ? Date.parse(connection.last_success_at)
                      : NaN;
                    const fresh =
                      Number.isFinite(last) && Date.now() - last <= 86400000;
                    const legacy = /^enablebanking:(rodion|katya)$/.test(
                      connection.connection,
                    );
                    return (
                      <Card
                        key={connection.connection}
                        className="gap-3 shadow-xs"
                      >
                        <CardHeader>
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <CardTitle className="break-words text-sm capitalize">
                              {connection.connection.replaceAll(':', ' · ')}
                            </CardTitle>
                            <Badge
                              variant="outline"
                              className={
                                connection.state === 'failed'
                                  ? 'text-warning'
                                  : ''
                              }
                            >
                              {connection.state}
                            </Badge>
                          </div>
                          {legacy && (
                            <p className="text-xs text-muted-foreground">
                              Legacy combined status
                            </p>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-sm">
                            {!Number.isFinite(last)
                              ? 'No complete run yet'
                              : fresh
                                ? 'Last complete run within 24 hours'
                                : 'Last complete run is over 24 hours old'}
                          </p>
                          {connection.last_success_at && (
                            <p className="text-xs text-muted-foreground">
                              Last complete run:{' '}
                              {date(connection.last_success_at)}
                            </p>
                          )}
                          {connection.error_code && (
                            <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-3 text-xs leading-relaxed">
                              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                              <p>
                                {advice[connection.error_code] ??
                                  'Import needs review before retrying.'}
                              </p>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-8 text-center">
                  <Activity className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    No bank import has run yet
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Every connection and its history is on the Bank imports
                    page; approvals are on Bank connections.
                  </p>
                </div>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                A complete run covers only its requested date window. It does
                not prove that all historical transactions are present.
              </p>
            </section>
            <section className="space-y-3">
              <h2 className="text-base font-semibold">Credential expiry</h2>
              {health.credentials.length ? (
                health.credentials.map((credential) => (
                  <Card key={credential.credential} className="gap-3 shadow-xs">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <KeyRound className="size-4 text-primary" />
                        OpenAI API key
                      </CardTitle>
                      <Badge variant="outline" className="w-fit">
                        {labels[credential.state] ?? credential.state}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p>
                        {credential.expiresOn
                          ? `Configured expiry: ${credential.expiresOn} (Europe/Riga date; exact time unknown)`
                          : credential.expiresAt
                            ? `Configured expiry: ${date(credential.expiresAt)}`
                            : 'No valid expiry date configured.'}
                      </p>
                      {credential.daysRemaining !== null && (
                        <p className="text-xs text-muted-foreground">
                          {credential.daysRemaining < 0
                            ? `${Math.abs(credential.daysRemaining)} calendar days past the configured expiry`
                            : `${credential.daysRemaining} calendar days remaining`}
                        </p>
                      )}
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Replacement reminder thresholds: 5, 2 and 1 calendar
                        days before expiry, using Europe/Riga. This is expiry
                        metadata, not a live credential test or confirmation of
                        reminder delivery.
                      </p>
                    </CardContent>
                  </Card>
                ))
              ) : (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No credential expiry metadata is available in this workspace.
                </p>
              )}
            </section>
            <details className="rounded-lg border bg-card p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Technical diagnostics
              </summary>
              <p className="mt-3 text-xs text-muted-foreground">
                Synthetic import status is separate from bank import status
                above.
              </p>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                {JSON.stringify({ ...health, release }, null, 2)}
              </pre>
            </details>
          </>
        )
      )}
    </div>
  );
}
