import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  apiGet,
  useSession,
  invalidateFinancialData,
  queryClient,
} from './lib/query';
import { Button } from './components/ui/button';
import { Label } from './components/ui/label';
import { Card, CardContent } from './components/ui/card';
type Settings = {
  revision: number;
  hideNonPersonal: boolean;
  hideInternalTransfers: boolean;
  hideRefunds: boolean;
  hideZeroAmount: boolean;
};
export default function Settings() {
  const session = useSession();
  const actor = session.data?.actor;
  const allowed = session.data?.isAdmin === true;
  const query = useQuery({
    queryKey: ['settings', actor],
    enabled: allowed,
    queryFn: ({ signal }) =>
      apiGet<{ settings: Settings }>('/api/settings', signal),
  });
  const [draft, setDraft] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (query.data) setDraft(query.data.settings);
  }, [query.data]);
  if (session.isPending) return <p role="status">Loading settings…</p>;
  if (session.error) return <p role="alert">{session.error.message}</p>;
  if (!allowed)
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p>
          Household settings are managed by Rodion. You can manage your own bank
          approval from Bank connections.
        </p>
        <a className="underline" href="/connections">
          Bank connections
        </a>
      </div>
    );
  async function save() {
    if (!draft || !session.data || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        credentials: 'same-origin',
        body: new URLSearchParams({
          csrf: session.data.csrf,
          revision: String(draft.revision),
          hideNonPersonal: String(draft.hideNonPersonal),
          hideInternalTransfers: String(draft.hideInternalTransfers),
          hideRefunds: String(draft.hideRefunds),
          hideZeroAmount: String(draft.hideZeroAmount),
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'Settings changed elsewhere. Refresh before saving again.'
            : 'Could not save settings. Please retry.',
        );
      const result = (await response.json()) as { settings: Settings };
      queryClient.setQueryData(['settings', actor], result);
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await invalidateFinancialData();
      setNotice('Household browsing defaults saved.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save settings.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Household settings</h1>
        <p className="text-sm text-muted-foreground">
          Default visibility for both family members. These settings never
          delete bank records or change spending calculations.
        </p>
      </header>
      {(error || query.error) && (
        <p role="alert" className="rounded-lg border border-destructive p-3">
          {error || query.error?.message}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border p-3">
          {notice}
        </p>
      )}
      {draft ? (
        <Card>
          <CardContent className="space-y-5 p-5">
            {(
              [
                [
                  'hideNonPersonal',
                  'Hide non-personal payments',
                  'Payments classified as not the household\u2019s own spending, wherever they were paid from. The account a payment sits on no longer decides this; investments stay visible.',
                ],
                [
                  'hideInternalTransfers',
                  'Hide family and own-account transfers',
                  'Only confirmed transfers are hidden; uncertain transfers remain visible.',
                ],
                [
                  'hideRefunds',
                  'Hide linked refund credits',
                  'Money returned against a purchase is already counted through that purchase.',
                ],
                [
                  'hideZeroAmount',
                  'Hide payments that came to nothing',
                  'Anything whose amount works out to zero in its own account currency, a purchase refunded in full above all. They stay in your history.',
                ],
              ] as const
            ).map(([key, title, description]) => (
              <div key={key} className="flex items-start gap-3">
                <input
                  id={key}
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={draft[key]}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.checked })
                  }
                />
                <div className="grid gap-2">
                  <Label htmlFor={key}>{title}</Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-3 pt-2">
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save defaults'}
              </Button>
              <Button
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => void query.refetch()}
              >
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <p role="status">Loading browsing defaults…</p>
      )}
      <div className="space-y-3 text-sm">
        <h2 className="font-medium">Connected services</h2>
        <div className="flex flex-wrap gap-4">
          <a className="underline" href="/accounts">
            Accounts & exclusions
          </a>
          <a className="underline" href="/connections">
            Bank connections
          </a>
          <a className="underline" href="/ops">
            AI budget & system health
          </a>
        </div>
      </div>
    </div>
  );
}
