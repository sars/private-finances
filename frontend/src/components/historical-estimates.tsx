import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, useSession } from '@/lib/query';
import { money } from '@/lib/format';
import {
  historicalEstimateBreakdown,
  type EstimateGroup,
  type HistoricalProjectionRow,
} from '@/lib/historical-estimate-breakdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type Overview = {
  transactions: Array<{
    id: string;
    revision?: number;
    bookedAt: string;
    amountMinor: string;
    kind: string;
    status?: string;
    spendingPolicy?: { excluded: boolean };
  }>;
  reporting: {
    currency: string;
    rows: Array<{
      id: string;
      convertedAmountMinor: string | null;
      netAmountMinor?: string | null;
      counted: string;
    }>;
    historicalEstimates?: {
      estimatedMinor: string;
      unknownMinor: string;
      estimatedCount: number;
      unknownCount: number;
      missing: number;
      rows?: HistoricalProjectionRow[];
    };
  };
};

/**
 * Older payments the model or the merchant code placed tentatively. Shown only
 * on request, always apart from confirmed spending, never changing a record.
 */
export function HistoricalEstimates({
  from,
  to,
  owner,
  display,
}: {
  from: string;
  to: string;
  owner: string;
  display: string;
}) {
  const [show, setShow] = useState(false);
  const actor = useSession().data?.actor;
  const params = new URLSearchParams({ display });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (owner !== 'all') params.set('owner', owner);
  const query = useQuery({
    queryKey: ['overview-estimates', actor, params.toString()],
    enabled: show && Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<Overview>('/api/overview?' + params.toString(), signal),
  });
  const estimates = query.data?.reporting.historicalEstimates;
  const groups =
    query.data && estimates
      ? historicalEstimateBreakdown(
          query.data.transactions,
          query.data.reporting.rows,
          estimates.rows ?? [],
        )
      : null;
  const currency = query.data?.reporting.currency ?? display;
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <Label className="gap-2 font-medium">
            <Checkbox
              checked={show}
              onCheckedChange={(checked) => setShow(Boolean(checked))}
            />
            Show historical estimates
          </Label>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Older payments can carry a tentative merchant or MCC category.
          Estimates stay apart from confirmed spending and change no record.
        </p>
      </CardHeader>
      {show && (
        <CardContent className="space-y-4">
          {query.isPending ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : query.error ? (
            <p role="alert" className="text-sm text-destructive">
              {query.error.message}
            </p>
          ) : !estimates || !groups ? (
            <p className="text-sm text-muted-foreground">
              No tentative estimates in this period.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Additional estimated spending
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {money(estimates.estimatedMinor, currency)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {estimates.estimatedCount} tentative payments
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Still unexplained
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {money(estimates.unknownMinor, currency)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {estimates.unknownCount} payments need context
                  </p>
                </div>
              </div>
              {estimates.missing > 0 && (
                <p className="text-xs text-warning">
                  {estimates.missing} payments have no conversion rate and are
                  omitted from these amounts.
                </p>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <EstimateTable
                  title="Tentative spending by month"
                  label="Month"
                  rows={groups.months}
                  currency={currency}
                />
                <EstimateTable
                  title="Tentative spending by category"
                  label="Category"
                  rows={groups.categories}
                  currency={currency}
                />
              </div>
              {groups.missing > 0 && (
                <p className="text-xs text-warning">
                  {groups.missing} tentative payments are missing a
                  display-currency rate.
                </p>
              )}
              <a
                href="/review?all=0&window=historical"
                className="text-xs font-medium text-primary"
              >
                Inspect estimates and unclear payments →
              </a>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function EstimateTable({
  title,
  label,
  rows,
  currency,
}: {
  title: string;
  label: string;
  rows: EstimateGroup[];
  currency: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <h3 className="border-b bg-muted/30 px-3 py-2 text-xs font-medium">
        {title}
      </h3>
      {rows.length ? (
        <div className="max-h-72 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{label}</TableHead>
                <TableHead className="text-right">Payments</TableHead>
                <TableHead className="text-right">Estimate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="max-w-44 break-words whitespace-normal">
                    {row.label}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(row.minor, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          No converted tentative spending in this period.
        </p>
      )}
    </div>
  );
}
