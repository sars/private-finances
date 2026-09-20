import {
  invalidateFinancialData,
  observeSession,
  useRefreshSignal,
} from './lib/query';
import { owners, type Owner } from './lib/account-visuals';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, CircleAlert, Landmark, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Choice, Field, PageHeader, RefreshButton } from '@/components/finance';

type Connection = {
  bank: string;
  country: string;
  expiry: string;
  status: string;
};
type Session = {
  /** Which member is signed in; the names they are shown by live in one map. */
  actor: Owner;
  csrf: string;
  features: { consent: boolean; monobankJarsExcluded: boolean };
  /** The provider's name, sent back on the form, the name the owner reads,
   * and the country the form pre-fills for it. */
  banks: Array<{ name: string; label: string; country: string }>;
};
/** "Wise, Revolut, Swedbank and LHV": the heading of the provider card. */
function bankListSentence(banks: Session['banks']) {
  const labels = banks.map((b) => b.label);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : labels.join('');
}
/** The name the owner knows a bank by, for an approval stored under the provider's name. */
function bankLabel(banks: Session['banks'], name: string) {
  return banks.find((b) => b.name === name)?.label ?? name;
}
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
  /** Choosing a bank chooses its country too; the field stays editable. */
  function chooseBank(name: string) {
    setBank(name);
    const chosen = session?.banks.find((b) => b.name === name);
    if (chosen) setCountry(chosen.country);
  }
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRefreshSignal();
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
            : `We couldn’t start approval for ${bankLabel(session.banks, bank)} in ${country}. Check the country code and try again.`,
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
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <PageHeader
        title="Bank connections"
        description="Approval for your own accounts, and whether each one still has access."
        actions={<RefreshButton />}
      />
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
                onClick={() => void invalidateFinancialData()}
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
          <Skeleton className="h-60 rounded-lg" />
          <Skeleton className="h-60 rounded-lg" />
        </div>
      ) : (
        session && (
          <>
            <div className="flex items-start gap-3 rounded-lg border bg-card p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">
                  Signed in as {owners[session.actor].name}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Approve only your own bank accounts. Approval does not
                  automatically import transactions or classify spending.
                </p>
              </div>
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Landmark className="size-4 text-primary" />
                    {bankListSentence(session.banks)}
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
                        <Field label="Bank" htmlFor="connection-bank">
                          <Choice
                            id="connection-bank"
                            className="w-full"
                            value={bank}
                            onChange={chooseBank}
                            options={session.banks.map((b) => ({
                              value: b.name,
                              label: b.label,
                            }))}
                            disabled={starting}
                          />
                        </Field>
                        <Field
                          label="Country of your bank connection"
                          htmlFor="connection-country"
                        >
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
                        </Field>
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
              <Card className="shadow-xs">
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
                  <Button
                    variant="outline"
                    size="sm"
                    render={<a href="/ops" />}
                  >
                    Check import health
                    <ArrowUpRight className="ml-2 size-3.5" />
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
                        className="gap-3 shadow-xs"
                      >
                        <CardHeader>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle className="text-base">
                              {bankLabel(session.banks, connection.bank)} ·{' '}
                              {connection.country}
                            </CardTitle>
                            <Badge
                              variant="outline"
                              className={
                                expired || connection.status === 'failed'
                                  ? 'text-warning'
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
                            <p className="mt-3 text-xs text-warning">
                              Start a new bank approval above to renew access.
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-8 text-center">
                  <ShieldCheck className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    No bank approval recorded for you yet
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
