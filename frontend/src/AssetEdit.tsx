import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { apiGet, useSession } from './lib/query';
import { useDisplayCurrency } from './lib/display-currency';
import {
  feedHints,
  feedNames,
  holdingKinds,
  holdingsUrl,
  ownerNames,
  postForm,
  refreshHoldings,
  sourceNames,
  type Feed,
  type Holding,
  type HoldingRow,
  type HoldingsReport,
  type LinkableAccount,
} from './lib/holdings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Choice, Money, PageHeader } from '@/components/finance';

/**
 * One holding's settings, on a page of its own: /assets/new to add one and
 * /assets/:id to change one. The figures are counted on the snapshots page;
 * this page only decides what the thing is and where its figure comes from.
 */
export default function AssetEdit() {
  const { currency: display } = useDisplayCurrency();
  const { data: session } = useSession();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? '';
  const query = useQuery({
    queryKey: ['holdings', display, ''],
    queryFn: ({ signal }) =>
      apiGet<HoldingsReport>(holdingsUrl(display), signal),
  });
  const report = query.data;
  const row = id
    ? (report?.rows.find((candidate) => candidate.holding.id === id) ?? null)
    : null;

  if (query.error)
    return (
      <div className="mx-auto max-w-3xl space-y-4 pb-8">
        <BackLink display={display} />
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  if (!report)
    return (
      <div className="mx-auto max-w-3xl space-y-4 pb-8" role="status">
        <BackLink display={display} />
        <Skeleton className="h-96 rounded-lg" />
        <span className="sr-only">Loading the holding</span>
      </div>
    );
  if (id && !row)
    return (
      <div className="mx-auto max-w-3xl space-y-4 pb-8">
        <BackLink display={display} />
        <PageHeader
          title="Holding"
          description="This holding is not in the current report. It may have been removed."
        />
      </div>
    );
  return (
    <HoldingForm
      key={id || 'new'}
      row={row}
      accounts={report.accounts}
      display={display}
      csrf={session?.csrf}
    />
  );
}

function BackLink({ display }: { display: string }) {
  return (
    <Button variant="ghost" render={<a href={`/assets?display=${display}`} />}>
      <ArrowLeft className="size-4" />
      Back to assets
    </Button>
  );
}

type Draft = {
  name: string;
  kind: string;
  denomination: string;
  invested: boolean;
  liquid: boolean;
  owner: string;
  group: string;
  maturesOn: string;
  note: string;
  archived: boolean;
  feed: string;
  feedRef: string;
};

/** Where both buttons lead; a plain string, which is what the router takes. */
const assetsPath = '/assets' as string;

const blank: Draft = {
  name: '',
  kind: 'bank',
  denomination: 'USD',
  invested: false,
  liquid: true,
  owner: '',
  group: '',
  maturesOn: '',
  note: '',
  archived: false,
  feed: '',
  feedRef: '',
};

const draftOf = (holding: Holding): Draft => ({
  name: holding.name,
  kind: holding.kind,
  denomination: holding.denomination,
  invested: holding.invested,
  liquid: holding.liquid,
  owner: holding.owner ?? '',
  group: holding.group ?? '',
  maturesOn: holding.maturesOn ?? '',
  note: holding.note ?? '',
  archived: holding.archived,
  feed: holding.feed ?? '',
  feedRef: holding.feedRef ?? '',
});

function HoldingForm({
  row,
  accounts,
  display,
  csrf,
}: {
  row: HoldingRow | null;
  accounts: LinkableAccount[];
  display: string;
  csrf?: string;
}) {
  const prefix = useId();
  const router = useRouter();
  const holding = row?.holding ?? null;
  const [draft, setDraft] = useState<Draft>(holding ? draftOf(holding) : blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof Draft) => (value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // The assets list keeps the display currency it was left in.
  const goToAssets = () =>
    void router.navigate({ to: assetsPath, search: { display } });

  // Picking a bank account says most of what the holding is: the account's own
  // name, whose it is, and — when the bank states one currency — its unit.
  function pickAccount(value: string) {
    const account = accounts.find(
      (candidate) => `${candidate.source}|${candidate.accountId}` === value,
    );
    setDraft((current) => ({
      ...current,
      feedRef: value,
      ...(account
        ? {
            name: account.displayName,
            owner: account.owner,
            ...(account.currencies.length === 1
              ? { denomination: account.currencies[0]!.toUpperCase() }
              : {}),
          }
        : {}),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!csrf || saving) return;
    if (!draft.name.trim()) {
      setError('Give the holding a name.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/.test(draft.denomination.trim())) {
      setError('The unit is a currency code or a symbol, such as USD or QQQ.');
      return;
    }
    if (
      draft.maturesOn &&
      !/^\d{4}-\d{2}-\d{2}$/.test(draft.maturesOn.trim())
    ) {
      setError('Write the maturity date as YYYY-MM-DD.');
      return;
    }
    if (draft.feed && !draft.feedRef.trim()) {
      setError(
        draft.feed === 'bank'
          ? 'Pick the account whose balance fills this holding.'
          : 'Say which reference this feed should read.',
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await postForm('/api/holdings', {
        csrf,
        ...(holding
          ? { id: holding.id, revision: String(holding.revision) }
          : {}),
        name: draft.name.trim(),
        kind: draft.kind,
        denomination: draft.denomination.trim().toUpperCase(),
        invested: String(draft.invested),
        liquid: String(draft.liquid),
        owner: draft.owner,
        group: draft.group.trim(),
        maturesOn: draft.maturesOn.trim(),
        note: draft.note.trim(),
        archived: String(draft.archived),
        feed: draft.feed,
        feedRef: draft.feed ? draft.feedRef.trim() : '',
      });
      await refreshHoldings();
      goToAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Not saved.');
    } finally {
      setSaving(false);
    }
  }

  const accountOptions = accounts.map((account) => ({
    value: `${account.source}|${account.accountId}`,
    label: account.displayName,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <BackLink display={display} />
      <PageHeader
        title={holding ? 'Edit holding' : 'Add a holding'}
        description="One thing with a value. Its unit decides how the amount is counted: a currency for money, a symbol for shares or coins."
      />
      {row && (
        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Counted now</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
            <span className="tabular-nums">
              {row.quantity ?? '—'}{' '}
              <span className="text-xs text-muted-foreground">
                {row.holding.denomination}
              </span>
            </span>
            {row.valueMinor !== null && (
              <Money
                minor={row.valueMinor}
                currency={display}
                className="font-medium"
              />
            )}
            <span className="text-xs text-muted-foreground">
              {row.quantityAsOf
                ? `${row.carried ? 'carried from' : 'counted'} ${row.quantityAsOf}`
                : 'never counted'}
              {row.source ? ` · ${sourceNames[row.source] ?? row.source}` : ''}
            </span>
          </CardContent>
        </Card>
      )}
      <Card className="shadow-xs">
        <CardContent>
          <form onSubmit={submit} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${prefix}-name`}>Name</Label>
                <Input
                  id={`${prefix}-name`}
                  value={draft.name}
                  onChange={(event) => set('name')(event.target.value)}
                  maxLength={120}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-kind`}>Kind</Label>
                <Choice
                  id={`${prefix}-kind`}
                  value={draft.kind}
                  onChange={set('kind')}
                  options={Object.entries(holdingKinds).map(
                    ([value, label]) => ({ value, label }),
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-unit`}>Unit</Label>
                <Input
                  id={`${prefix}-unit`}
                  value={draft.denomination}
                  onChange={(event) =>
                    set('denomination')(event.target.value.toUpperCase())
                  }
                  placeholder="USD, EUR, UAH, BTC, QQQ…"
                  maxLength={16}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-group`}>Group</Label>
                <Input
                  id={`${prefix}-group`}
                  value={draft.group}
                  onChange={(event) => set('group')(event.target.value)}
                  placeholder="Optional, such as a broker"
                  maxLength={80}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-owner`}>Whose</Label>
                <Choice
                  id={`${prefix}-owner`}
                  value={draft.owner}
                  onChange={set('owner')}
                  options={[
                    { value: '', label: 'Household' },
                    { value: 'rodion', label: ownerNames.rodion },
                    { value: 'katya', label: ownerNames.katya },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-matures`}>Matures on</Label>
                <Input
                  id={`${prefix}-matures`}
                  value={draft.maturesOn}
                  onChange={(event) => set('maturesOn')(event.target.value)}
                  placeholder="YYYY-MM-DD, for a bond or deposit"
                  maxLength={10}
                />
              </div>
              <div className="flex flex-col justify-end gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.invested}
                    onCheckedChange={(checked) =>
                      set('invested')(Boolean(checked))
                    }
                  />
                  Invested
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={draft.liquid}
                    onCheckedChange={(checked) =>
                      set('liquid')(Boolean(checked))
                    }
                  />
                  Liquid
                </label>
                {holding && (
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={draft.archived}
                      onCheckedChange={(checked) =>
                        set('archived')(Boolean(checked))
                      }
                    />
                    Retired, keep its history
                  </label>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-feed`}>Filled by</Label>
                <Choice
                  id={`${prefix}-feed`}
                  value={draft.feed}
                  onChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      feed: value,
                      feedRef: '',
                    }))
                  }
                  options={[
                    { value: '', label: 'Typed by hand' },
                    ...Object.entries(feedNames).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  ]}
                />
              </div>
              {draft.feed && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${prefix}-ref`}>
                    {draft.feed === 'bank' ? 'Account' : 'Reference'}
                  </Label>
                  {draft.feed === 'bank' ? (
                    <Choice
                      id={`${prefix}-ref`}
                      value={draft.feedRef}
                      onChange={pickAccount}
                      placeholder={
                        accountOptions.length
                          ? 'Pick an account'
                          : 'No account is connected yet'
                      }
                      options={accountOptions}
                    />
                  ) : (
                    <Input
                      id={`${prefix}-ref`}
                      value={draft.feedRef}
                      onChange={(event) => set('feedRef')(event.target.value)}
                      placeholder={
                        draft.feed === 'ibkr'
                          ? draft.denomination || 'symbol, or CASH'
                          : draft.feed === 'binance'
                            ? 'TOTAL'
                            : 'public address'
                      }
                      maxLength={200}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {feedHints[draft.feed as Feed]}
                  </p>
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${prefix}-note`}>Note</Label>
                <Textarea
                  id={`${prefix}-note`}
                  value={draft.note}
                  onChange={(event) => set('note')(event.target.value)}
                  rows={3}
                  maxLength={2000}
                />
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={saving || !csrf}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="outline" onClick={goToAssets}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
