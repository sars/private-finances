import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CircleAlert, Inbox, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { apiGet, useSession, invalidateFinancialData } from './lib/query';
import { useSearchPatch, useUrlSearch } from './lib/navigation';
import { useDisplayCurrency } from './lib/display-currency';
import { exponentOf } from './lib/format';
import {
  usePaymentContext,
  usePaymentPages,
  type PaymentFilters,
} from './lib/payments';
import { kinds, type Kind } from './lib/transactions';
import { owners } from './lib/account-visuals';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/combobox';
import {
  Choice,
  EmptyState,
  Field,
  FilterBar,
  PagedList,
  PageHeader,
  PeriodPicker,
  presetPeriod,
} from '@/components/finance';
import { PaymentRow } from '@/components/transaction/payment-row';
import type { CategoryNode, Tag } from '@/components/transaction/decision-card';

/** The search box writes to the URL only once typing pauses. */
function useDebouncedField(
  value: string,
  onCommit: (value: string) => void,
  delay = 250,
) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onCommit(draft), delay);
    return () => clearTimeout(timer);
  }, [draft, value, onCommit, delay]);
  return [draft, setDraft] as const;
}

/** "12.50" in the display currency → minor units for the request; nothing
 * when the text is not an amount. */
function minorOf(text: string, currency: string): string | undefined {
  const match = /^\s*(\d{1,12})(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!match) return undefined;
  const exponent = exponentOf(currency) ?? 2;
  const fraction = (match[2] ?? '').padEnd(exponent, '0').slice(0, exponent);
  return String(BigInt(match[1]! + fraction));
}

const kindOptions = [
  { value: 'all', label: 'Every type' },
  ...(Object.keys(kinds) as Kind[]).map((kind) => ({
    value: kind,
    label: kinds[kind],
  })),
];
const presenceOptions = (thing: string) => [
  { value: 'all', label: 'Any' },
  { value: 'with', label: `With a ${thing}` },
  { value: 'without', label: `Without a ${thing}` },
];

export default function Transactions() {
  const url = useUrlSearch();
  const patch = useSearchPatch();
  const session = useSession();
  const identity = session.data;
  const actor = identity?.actor;
  const { currency: displayCurrency } = useDisplayCurrency();
  const defaults = presetPeriod('month');
  const from = url.from ?? defaults.from;
  const to = url.to ?? defaults.to;
  const who = url.who === 'rodion' || url.who === 'katya' ? url.who : 'all';
  const kind = url.kind && url.kind in kinds ? (url.kind as Kind) : 'all';
  const pattern =
    url.pattern === 'routine' || url.pattern === 'exceptional'
      ? url.pattern
      : 'all';
  const receipts =
    url.receipts === 'with' || url.receipts === 'without'
      ? url.receipts
      : 'all';
  const refunds =
    url.refunds === 'with' || url.refunds === 'without' ? url.refunds : 'all';
  const category = url.category ?? '';
  const tag = url.tag ?? '';
  const search = url.q ?? '';
  const [draft, setDraft] = useDebouncedField(search, (value) =>
    patch({ q: value || undefined }, true),
  );
  const [minText, setMinText] = useDebouncedField(url.min ?? '', (value) =>
    patch({ min: value || undefined }, true),
  );
  const [maxText, setMaxText] = useDebouncedField(url.max ?? '', (value) =>
    patch({ max: value || undefined }, true),
  );
  // A link that arrives with filters set shows them; otherwise they wait
  // behind one button.
  const [filtersExpanded, setFiltersExpanded] = useState(() =>
    Boolean(
      url.category ||
      url.kind ||
      url.pattern ||
      url.receipts ||
      url.refunds ||
      url.tag ||
      url.min ||
      url.max,
    ),
  );

  // The household's visibility defaults, overridable here for this visit.
  const shown = (key: string, hidden: boolean | undefined) =>
    url[key] !== undefined ? url[key] === '1' : !(hidden ?? true);
  const includeNonPersonal = shown(
    'includeNonPersonal',
    identity?.reviewDefaults?.hideNonPersonal,
  );
  const includeTransfers = shown(
    'includeTransfers',
    identity?.reviewDefaults?.hideInternalTransfers,
  );
  const includeRefunds = shown(
    'includeRefunds',
    identity?.reviewDefaults?.hideRefunds,
  );
  const includeZeroAmount = shown(
    'includeZeroAmount',
    identity?.reviewDefaults?.hideZeroAmount,
  );

  const filters: PaymentFilters = {
    display: displayCurrency,
    from,
    to,
    ...(who === 'all' ? {} : { owner: who }),
    ...(search ? { q: search } : {}),
    ...(category ? { category } : {}),
    ...(kind === 'all' ? {} : { kinds: kind }),
    ...(pattern === 'all' ? {} : { pattern }),
    ...(receipts === 'all' ? {} : { receipts }),
    ...(refunds === 'all' ? {} : { refunds }),
    ...(tag ? { tag } : {}),
    ...(url.min ? { min: minorOf(url.min, displayCurrency) } : {}),
    ...(url.max ? { max: minorOf(url.max, displayCurrency) } : {}),
    // Asking for a type the household normally hides means: show it.
    ...(url.includeNonPersonal !== undefined || kind === 'non_personal'
      ? {
          includeNonPersonal:
            kind === 'non_personal' ? '1' : url.includeNonPersonal,
        }
      : {}),
    ...(url.includeTransfers !== undefined || kind === 'internal_transfer'
      ? {
          includeTransfers:
            kind === 'internal_transfer' ? '1' : url.includeTransfers,
        }
      : {}),
    ...(url.includeRefunds !== undefined || refunds === 'with'
      ? { includeRefunds: refunds === 'with' ? '1' : url.includeRefunds }
      : {}),
    ...(url.includeZeroAmount !== undefined
      ? { includeZeroAmount: url.includeZeroAmount }
      : {}),
  };
  const pages = usePaymentPages(actor, filters);
  const context = usePaymentContext(pages.data?.pages);
  const payments = pages.data?.pages.flatMap((page) => page.transactions) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const categories = useQuery({
    queryKey: ['categories', actor],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<{ nodes: CategoryNode[]; tags: Tag[] }>('/api/categories', signal),
  });
  const loading = session.isPending || pages.isPending;
  const error =
    [session.error, pages.error, categories.error].find(Boolean)?.message ?? '';
  const filtered = Boolean(
    who !== 'all' ||
    category ||
    kind !== 'all' ||
    pattern !== 'all' ||
    receipts !== 'all' ||
    refunds !== 'all' ||
    tag ||
    url.min ||
    url.max ||
    url.includeNonPersonal !== undefined ||
    url.includeTransfers !== undefined ||
    url.includeRefunds !== undefined ||
    url.includeZeroAmount !== undefined,
  );
  const categoryOptions = [
    { value: '*', label: 'Every category' },
    ...(categories.data?.nodes ?? [])
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => ({
        value: node.path,
        label: node.name,
        display: node.path,
        group: node.path.includes(' / ')
          ? node.path.split(' / ')[0]!
          : 'Top level',
        hint: node.assignable ? undefined : 'whole branch',
      })),
  ];
  const whoLabel =
    who === 'all' ? 'Both of us' : owners[who as 'rodion' | 'katya'].name;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description="Every payment on the household's accounts, newest first."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              render={<a href={'/cash?display=' + displayCurrency} />}
            >
              Add cash expense
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pages.isFetching}
              onClick={() => void invalidateFinancialData()}
            >
              <RefreshCw className={pages.isFetching ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </>
        }
      />
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4 text-sm"
        >
          <span className="flex items-center gap-2">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void invalidateFinancialData()}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker
          value={{ from, to }}
          onChange={(next) => patch({ from: next.from, to: next.to })}
        />
        <Button
          variant={filtered ? 'secondary' : 'ghost'}
          size="sm"
          aria-expanded={filtersExpanded}
          aria-controls="transactions-filters"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
        >
          <SlidersHorizontal />
          Filters
        </Button>
      </div>
      <FilterBar>
        <Field label="Whose" htmlFor="transactions-who">
          <Choice
            id="transactions-who"
            className="w-full sm:w-44"
            value={who}
            onChange={(value) =>
              patch({ who: value === 'all' ? undefined : value })
            }
            options={[
              { value: 'all', label: 'Both of us' },
              ...(['rodion', 'katya'] as const).map((member) => ({
                value: member,
                label:
                  member === actor
                    ? `${owners[member].name} (me)`
                    : owners[member].name,
              })),
            ]}
          />
        </Field>
        <Field
          label="Search"
          htmlFor="transactions-search"
          className="sm:flex-1"
        >
          <Input
            id="transactions-search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search descriptions"
          />
        </Field>
      </FilterBar>
      {filtersExpanded && (
        <FilterBar id="transactions-filters">
          <Field label="Category" htmlFor="transactions-category">
            <Combobox
              id="transactions-category"
              className="h-9 w-full py-0 sm:w-56"
              options={categoryOptions}
              value={category || '*'}
              onChange={(value) =>
                patch({ category: value === '*' ? undefined : value })
              }
              placeholder="Every category"
              searchPlaceholder="Type to search categories…"
              emptyText="No category matches that search."
            />
          </Field>
          <Field label="Type" htmlFor="transactions-kind">
            <Choice
              id="transactions-kind"
              className="w-full sm:w-44"
              value={kind}
              onChange={(value) =>
                patch({ kind: value === 'all' ? undefined : value })
              }
              options={kindOptions}
            />
          </Field>
          <Field label="Pattern" htmlFor="transactions-pattern">
            <Choice
              id="transactions-pattern"
              className="w-full sm:w-40"
              value={pattern}
              onChange={(value) =>
                patch({ pattern: value === 'all' ? undefined : value })
              }
              options={[
                { value: 'all', label: 'Any pattern' },
                { value: 'routine', label: 'Routine only' },
                { value: 'exceptional', label: 'Exceptional only' },
              ]}
            />
          </Field>
          <Field
            label={`Amount (${displayCurrency})`}
            htmlFor="transactions-min"
            className="sm:w-60"
          >
            <div className="flex items-center gap-2">
              <Input
                id="transactions-min"
                inputMode="decimal"
                aria-label={`Amount from, ${displayCurrency}`}
                value={minText}
                onChange={(e) => setMinText(e.target.value)}
                placeholder="From"
                aria-invalid={Boolean(
                  minText && !minorOf(minText, displayCurrency),
                )}
              />
              <span aria-hidden="true" className="text-muted-foreground">
                –
              </span>
              <Input
                id="transactions-max"
                inputMode="decimal"
                aria-label={`Amount up to, ${displayCurrency}`}
                value={maxText}
                onChange={(e) => setMaxText(e.target.value)}
                placeholder="To"
                aria-invalid={Boolean(
                  maxText && !minorOf(maxText, displayCurrency),
                )}
              />
            </div>
          </Field>
          <Field label="Receipts" htmlFor="transactions-receipts">
            <Choice
              id="transactions-receipts"
              className="w-full sm:w-52"
              value={receipts}
              onChange={(value) =>
                patch({ receipts: value === 'all' ? undefined : value })
              }
              options={presenceOptions('receipt')}
            />
          </Field>
          <Field label="Refunds" htmlFor="transactions-refunds">
            <Choice
              id="transactions-refunds"
              className="w-full sm:w-52"
              value={refunds}
              onChange={(value) =>
                patch({ refunds: value === 'all' ? undefined : value })
              }
              options={presenceOptions('refund')}
            />
          </Field>
          <Field label="Tag" htmlFor="transactions-tag">
            <Choice
              id="transactions-tag"
              className="w-full sm:w-44"
              value={tag}
              onChange={(value) => patch({ tag: value || undefined })}
              options={[
                { value: '', label: 'Any tag' },
                ...(categories.data?.tags ?? []).map((t) => ({
                  value: t.id,
                  label: t.name,
                })),
              ]}
            />
          </Field>
          <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-3 border-t pt-4">
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeNonPersonal}
                onCheckedChange={(checked) =>
                  patch({ includeNonPersonal: checked ? '1' : '0' })
                }
              />
              Show non-personal payments
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeTransfers}
                onCheckedChange={(checked) =>
                  patch({ includeTransfers: checked ? '1' : '0' })
                }
              />
              Show confirmed transfers
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeRefunds}
                onCheckedChange={(checked) =>
                  patch({ includeRefunds: checked ? '1' : '0' })
                }
              />
              Show linked refund credits
            </Label>
            <Label className="gap-2 font-normal text-muted-foreground">
              <Checkbox
                checked={includeZeroAmount}
                onCheckedChange={(checked) =>
                  patch({ includeZeroAmount: checked ? '1' : '0' })
                }
              />
              Show payments that came to nothing
            </Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                patch({
                  includeNonPersonal: undefined,
                  includeTransfers: undefined,
                  includeRefunds: undefined,
                  includeZeroAmount: undefined,
                })
              }
            >
              Use household defaults
            </Button>
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  patch({
                    who: undefined,
                    category: undefined,
                    kind: undefined,
                    pattern: undefined,
                    receipts: undefined,
                    refunds: undefined,
                    tag: undefined,
                    min: undefined,
                    max: undefined,
                    includeNonPersonal: undefined,
                    includeTransfers: undefined,
                    includeRefunds: undefined,
                    includeZeroAmount: undefined,
                  })
                }
              >
                Clear filters
              </Button>
            )}
          </div>
        </FilterBar>
      )}
      <p className="text-xs text-muted-foreground">
        {from} – {to} · Europe/Riga · {whoLabel} · amounts in {displayCurrency},
        original bank amounts beside them
      </p>
      {pages.isFetching && pages.data && !pages.isFetchingNextPage && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating payments…
        </p>
      )}
      <PagedList
        items={payments}
        keyOf={(t) => t.id}
        loading={loading}
        hasMore={Boolean(pages.hasNextPage)}
        loadingMore={pages.isFetchingNextPage}
        onLoadMore={() => void pages.fetchNextPage()}
        empty={
          !error && (
            <EmptyState
              icon={Inbox}
              className="rounded-lg border border-dashed"
              title="No payments match"
              text="Widen the period, clear a filter, or show the kinds of money the household hides by default."
            />
          )
        }
        footer={
          payments.length && !pages.hasNextPage
            ? `All ${total} payments listed.`
            : payments.length
              ? `${payments.length} of ${total} listed`
              : undefined
        }
        renderRow={(t) => (
          <PaymentRow
            transaction={t}
            context={context}
            displayCurrency={displayCurrency}
            href={`/transactions/${encodeURIComponent(t.id)}?display=${displayCurrency}`}
            action={
              <Button
                size="sm"
                variant="outline"
                render={
                  <a
                    href={`/transactions/${encodeURIComponent(t.id)}?display=${displayCurrency}`}
                  />
                }
              >
                Open
              </Button>
            }
          />
        )}
      />
    </div>
  );
}
