import { observeSession } from './lib/query';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  CircleAlert,
  Landmark,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Connection = {
  bank: string;
  country: string;
  expiry: string;
  status: string;
};
type Session = {
  actor: string;
  csrf: string;
  features: { consent: boolean; monobankJarsExcluded: boolean };
};
function expiry(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Riga',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date) + ' (Riga)'
    : 'Expiry unavailable';
}
export default function Connections() {
  const [session, setSession] = useState<Session>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [bank, setBank] = useState('Wise');
  const [country, setCountry] = useState('LV');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const responses = await Promise.all([
          fetch('/api/bootstrap', {
            signal: controller.signal,
            credentials: 'same-origin',
          }),
          fetch('/api/connections', {
            signal: controller.signal,
            credentials: 'same-origin',
          }),
        ]);
        if (responses.some((r) => !r.ok))
          throw new Error(
            responses.some((r) => r.status === 401)
              ? 'Your session needs attention. Reload the page to sign in again.'
              : 'We couldn’t load bank connections. Please try again.',
          );
        const [identity, data] = await Promise.all(
          responses.map((r) => r.json()),
        );
        if (
          !Array.isArray(data.connections) ||
          !identity.csrf ||
          !identity.features
        )
          throw new Error(
            'The connection response was incomplete. Please try again.',
          );
        if (!controller.signal.aborted) {
          observeSession(identity);
          setSession(identity);
          setConnections(data.connections);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Unable to load connections.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!session?.features.consent || starting) return;
    if (!/^[A-Z]{2}$/.test(country)) {
      setError('Enter a two-letter country code, such as LV.');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const response = await fetch('/connections/enablebanking/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ csrf: session.csrf, bank, country }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? 'Your session changed. Reload before starting bank approval.'
            : 'We couldn’t start bank approval. Please try again.',
        );
      const data = await response.json();
      const destination = new URL(data.redirect);
      if (
        destination.protocol !== 'https:' ||
        !['auth.enablebanking.com', 'tilisy.enablebanking.com'].includes(
          destination.hostname,
        ) ||
        destination.username ||
        destination.password ||
        destination.port
      )
        throw new Error(
          'The bank approval address could not be verified. Please try again.',
        );
      window.location.assign(destination.href);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to start bank approval.',
      );
      setStarting(false);
    }
  }
  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Household finances
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Bank connections
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage approval for your own accounts and check their access status.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || starting}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw className="mr-2 size-3.5" />
          Refresh
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-3">
            <p>{error}</p>
            {!session && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefresh((n) => n + 1)}
              >
                Try again
              </Button>
            )}
          </div>
        </div>
      )}
      {loading ? (
        <div
          role="status"
          aria-label="Loading bank connections"
          className="grid gap-4 md:grid-cols-2"
        >
          <Skeleton className="h-60 rounded-xl" />
          <Skeleton className="h-60 rounded-xl" />
        </div>
      ) : (
        session && (
          <>
            <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">
                  Signed in as{' '}
                  <span className="capitalize">{session.actor}</span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Approve only your own bank accounts. Approval does not
                  automatically import transactions or classify spending.
                </p>
              </div>
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Landmark className="size-4 text-primary" />
                    Wise and Revolut
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Connect through Enable Banking.
                  </p>
                </CardHeader>
                <CardContent className="space-y-5">
                  {session.features.consent ? (
                    <>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        First link your accounts in Enable Banking’s application
                        settings. Continue below to review access with your
                        bank. Keep Tailscale connected when you return.
                      </p>
                      <form onSubmit={connect} className="space-y-4">
                        <div>
                          <label
                            htmlFor="connection-bank"
                            className="mb-1.5 block text-xs font-medium text-muted-foreground"
                          >
                            Bank
                          </label>
                          <Select
                            value={bank}
                            onValueChange={setBank}
                            disabled={starting}
                          >
                            <SelectTrigger
                              id="connection-bank"
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="Wise">Wise</SelectItem>
                              <SelectItem value="Revolut">Revolut</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label
                            htmlFor="connection-country"
                            className="mb-1.5 block text-xs font-medium text-muted-foreground"
                          >
                            Country of your bank connection
                          </label>
                          <Input
                            id="connection-country"
                            value={country}
                            onChange={(e) =>
                              setCountry(e.target.value.toUpperCase())
                            }
                            placeholder="LV"
                            minLength={2}
                            maxLength={2}
                            pattern="[A-Z]{2}"
                            autoCapitalize="characters"
                            required
                            disabled={starting}
                            aria-describedby="connection-country-help"
                          />
                          <p
                            id="connection-country-help"
                            className="mt-1.5 text-xs text-muted-foreground"
                          >
                            Two-letter country code, for example LV for Latvia.
                          </p>
                        </div>
                        <Button
                          className="w-full sm:w-auto"
                          type="submit"
                          disabled={starting}
                        >
                          {starting
                            ? 'Opening bank approval…'
                            : 'Continue to bank approval'}
                          <ArrowUpRight className="ml-2 size-4" />
                        </Button>
                      </form>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Bank approval is not configured yet. Existing imported
                      records remain available in your overview.
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Landmark className="size-4 text-primary" />
                    Monobank
                  </CardTitle>
                  <Badge variant="outline" className="w-fit">
                    {session.features.monobankJarsExcluded
                      ? 'Regular accounts only'
                      : 'Accounts and jars'}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {session.features.monobankJarsExcluded
                      ? 'Jars are excluded from future imports. Previously imported records remain visible.'
                      : 'All API-listed regular accounts and jars are in import scope.'}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Monobank token access is configured on the server. This
                    scope does not confirm that every account or date has been
                    imported.
                  </p>
                  <Button asChild variant="outline" size="sm">
                    <a href="/ops">
                      Check import health
                      <ArrowUpRight className="ml-2 size-3.5" />
                    </a>
                  </Button>
                </CardContent>
              </Card>
            </div>
            <section className="space-y-3">
              <h2 className="text-base font-semibold">Your bank approvals</h2>
              {connections.length ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {connections.map((connection) => {
                    const expired =
                      connection.status === 'authorized' &&
                      Number.isFinite(Date.parse(connection.expiry)) &&
                      Date.parse(connection.expiry) <= Date.now();
                    return (
                      <Card
                        key={`${connection.bank}:${connection.country}`}
                        className="gap-3 shadow-none"
                      >
                        <CardHeader>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle className="text-base">
                              {connection.bank} · {connection.country}
                            </CardTitle>
                            <Badge
                              variant="outline"
                              className={
                                expired || connection.status === 'failed'
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : ''
                              }
                            >
                              {expired
                                ? 'Expired'
                                : connection.status.replaceAll('_', ' ')}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="text-xs text-muted-foreground">
                            Approval expiry
                          </p>
                          <p className="mt-1 break-words text-sm">
                            {expiry(connection.expiry)}
                          </p>
                          {expired && (
                            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                              Start a new bank approval above to renew access.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed p-8 text-center">
                  <ShieldCheck className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    No Wise or Revolut approval recorded for you yet
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Your partner’s approvals are managed from their own sign-in.
                  </p>
                </div>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}
