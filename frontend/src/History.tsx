import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ArrowLeft, History as HistoryIcon, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
type Entry = {
  actor: string;
  event: string;
  reason: string | null;
  created_at: string;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
};
const fields = [
  'kind',
  'category',
  'status',
  'description',
  'amountMinor',
  'currency',
  'bookedAt',
];
const labels: Record<string, string> = {
  kind: 'Classification',
  category: 'Category',
  status: 'Settlement',
  description: 'Description',
  amountMinor: 'Amount (minor units)',
  currency: 'Currency',
  bookedAt: 'Booking date',
};
function show(value: unknown) {
  return value === null || value === undefined || value === ''
    ? '—'
    : String(value).replaceAll('_', ' ');
}
export default function History() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const id = pathname.split('/')[2];
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch('/api/history?id=' + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'This transaction history was not found.'
              : 'We couldn’t load the history. Please try again.',
          );
        return response.json();
      })
      .then((data) => {
        if (!Array.isArray(data.history))
          throw new Error('Unexpected history response.');
        if (!controller.signal.aborted) setEntries(data.history);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, id]);
  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-8">
      <Button asChild variant="ghost" className="-ml-3">
        <a href="/">
          <ArrowLeft className="size-4" />
          Back to overview
        </a>
      </Button>
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-[.14em] text-muted-foreground">
          Transaction record
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Decision history
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          See what changed, who changed it, and why. Old decisions stay visible.
        </p>
      </div>
      {loading ? (
        <Skeleton className="h-64" />
      ) : error ? (
        <div role="alert" className="rounded-lg border p-4 text-sm">
          {error}
          <Button
            variant="outline"
            className="ml-3"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw />
            Retry
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No history yet.</p>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry, i) => (
            <li key={`${entry.created_at}-${i}`}>
              <Card className="gap-0 py-0 shadow-none">
                <CardContent className="p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <HistoryIcon className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium capitalize">
                        {show(entry.event)}
                      </span>
                      <Badge variant="secondary" className="capitalize">
                        {entry.actor}
                      </Badge>
                    </div>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={entry.created_at}
                    >
                      {new Intl.DateTimeFormat('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'Europe/Riga',
                      }).format(new Date(entry.created_at))}{' '}
                      · Riga
                    </time>
                  </div>
                  {entry.reason && (
                    <p className="mb-4 whitespace-pre-wrap break-words text-sm">
                      {entry.reason}
                    </p>
                  )}
                  <dl className="divide-y">
                    {fields
                      .filter(
                        (field) =>
                          entry.after_value?.[field] !== undefined &&
                          (entry.before_value === null ||
                            entry.before_value?.[field] !==
                              entry.after_value?.[field]),
                      )
                      .map((field) => (
                        <div
                          key={field}
                          className="grid gap-1 py-2.5 text-xs sm:grid-cols-[140px_1fr]"
                        >
                          <dt className="text-muted-foreground">
                            {labels[field]}
                          </dt>
                          <dd className="min-w-0 break-words">
                            {entry.before_value && (
                              <span className="mr-2 text-muted-foreground line-through">
                                {show(entry.before_value[field])}
                              </span>
                            )}
                            <span>{show(entry.after_value?.[field])}</span>
                          </dd>
                        </div>
                      ))}
                  </dl>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
