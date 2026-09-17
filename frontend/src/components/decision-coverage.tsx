import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiGet, useSession } from '@/lib/query';
import { periodRange } from '@/lib/spending-period';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CategoryBar } from '@/components/finance';

type Sum = { netMinor: string; count: number; missingFx: number };
/** Who decided the money, in the three groups the owner asked to see. */
const groups: Array<{ label: string; sources: string[] }> = [
  {
    label: 'You or your rules',
    sources: ['human', 'rule', 'identity', 'bank', 'bank_worded'],
  },
  { label: 'The model', sources: ['model', 'memory'] },
  { label: 'Placed by default', sources: [] },
];

/**
 * The share of this year's spending decided by a person or a rule, by the
 * model, or placed by default. It says how the classification is doing, which
 * is a matter for System health rather than for reading the spending itself.
 */
export function DecisionCoverage() {
  const actor = useSession().data?.actor;
  const [from, to] = periodRange('year');
  const query = useQuery({
    queryKey: ['analytics', actor, `coverage:${from}:${to}`],
    enabled: Boolean(actor),
    queryFn: ({ signal }) =>
      apiGet<{ coverage: Record<string, Sum>; totals: Sum }>(
        `/api/analytics?display=UAH&bucket=month&series=none&from=${from}&to=${to}`,
        signal,
      ),
  });
  const segments = useMemo(() => {
    if (!query.data) return [];
    const grouped = groups.map((g) => ({ ...g, net: 0n, count: 0 }));
    for (const [source, s] of Object.entries(query.data.coverage)) {
      const group =
        grouped.find((g) => g.sources.includes(source)) ?? grouped[2]!;
      group.net += BigInt(s.netMinor);
      group.count += s.count;
    }
    return grouped.map((g) => ({ label: g.label, value: Number(g.net) }));
  }, [query.data]);
  if (!query.data || !query.data.totals.count) return null;
  return (
    <Card className="shadow-xs">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Who decided the money
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Share of this year's spending by who classified it:{' '}
          {query.data.totals.count} payments since {from}.
        </p>
      </CardHeader>
      <CardContent>
        <CategoryBar segments={segments} />
      </CardContent>
    </Card>
  );
}
