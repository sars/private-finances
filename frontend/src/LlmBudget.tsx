import { useEffect, useState } from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

type Budget = {
  month: string;
  timezone: string;
  budgetUsd: string;
  safetyReserveUsd: string;
  spentUsd: string;
  heldUsd: string;
  remainingUsd: string;
  requestCount: number;
  measuredRequests: number;
  reservedRequests: number;
  pauseReason: 'monthly_budget' | 'pricing_or_usage_anomaly' | null;
  uncertainRequests: number;
  legacyRequests: number;
  projectedUsd: string | null;
  state: 'healthy' | 'warning' | 'paused';
  daily: Array<{ date: string; spentUsd: string; heldUsd: string }>;
  byModel: Array<{
    model: string;
    requests: number;
    spentUsd: string;
    heldUsd: string;
  }>;
  trackingStartedAt: string;
};
// Cost accounting stays integer on the server. These numbers only format charts/labels.
const usd = (value: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: Number(value) > 0 && Number(value) < 0.01 ? 4 : 2,
  }).format(Number(value));
export default function LlmBudget({
  compact = false,
  refresh = 0,
}: {
  compact?: boolean;
  refresh?: number;
}) {
  const [data, setData] = useState<Budget>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch('/api/llm-budget', {
      signal: controller.signal,
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const value = await response.json();
        if (
          !value.month ||
          !Array.isArray(value.daily) ||
          !Number.isFinite(Number(value.remainingUsd))
        )
          throw new Error('incomplete');
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [refresh]);
  if (error)
    return (
      <p
        role="status"
        className="rounded-lg border px-4 py-3 text-sm text-muted-foreground"
      >
        AI budget unavailable. Spending limits remain enforced; refresh to check
        usage.
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Checking AI budget…
      </p>
    );
  const used = Number(data.spentUsd) + Number(data.heldUsd);
  const percent = Math.min(100, (used / Number(data.budgetUsd)) * 100);
  const status =
    data.state === 'paused'
      ? 'AI paused'
      : data.state === 'warning'
        ? 'Budget attention'
        : 'Within budget';
  if (compact)
    return (
      <a
        href="/ops#ai-budget"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3 text-xs"
      >
        <span className="flex items-center gap-2 font-medium">
          <Sparkles className="size-3.5" />
          AI budget
        </span>
        <span className="tabular-nums">
          {usd(data.spentUsd)} tracked / {usd(data.budgetUsd)} monthly
        </span>
        {Number(data.heldUsd) > 0 && (
          <span className="text-muted-foreground">
            {usd(data.heldUsd)} reserved
          </span>
        )}
        <Badge variant="outline" className="ml-auto">
          {status}
        </Badge>
        <ArrowUpRight className="size-3.5" />
      </a>
    );
  return (
    <Card id="ai-budget" className="gap-4 shadow-none scroll-mt-6">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            AI spending
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.month} · Riga calendar month · shared by both owners
          </p>
        </div>
        <Badge variant={data.state === 'paused' ? 'destructive' : 'outline'}>
          {status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {data.pauseReason === 'pricing_or_usage_anomaly' && (
          <p role="alert" className="text-sm">
            AI is paused because provider pricing or usage could not be
            verified. Review is required before spending resumes.
          </p>
        )}
        {data.pauseReason === 'monthly_budget' && (
          <p role="status" className="text-sm">
            The remaining allowance cannot safely cover another request. Manual
            review stays available.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Tracked cost', usd(data.spentUsd)],
            ['Reserved / uncertain', usd(data.heldUsd)],
            ['Available for AI', usd(data.remainingUsd)],
            ['Monthly maximum', usd(data.budgetUsd)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div>
          <div
            role="progressbar"
            aria-label="Monthly AI budget used including reservations"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {usd(data.safetyReserveUsd)} is kept as a safety buffer. New
            requests stop before the remaining allowance is consumed.
          </p>
        </div>
        {data.requestCount > 0 && (
          <div
            className="h-36"
            aria-label="Daily tracked AI cost and reservations in USD"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.daily.map((day) => ({
                  day: day.date.slice(-2),
                  tracked: Number(day.spentUsd),
                  reserved: Number(day.heldUsd),
                }))}
                margin={{ left: 0, right: 0, top: 8, bottom: 0 }}
              >
                <XAxis
                  dataKey="day"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                />
                <Tooltip
                  formatter={(value) => usd(String(value))}
                  contentStyle={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar
                  dataKey="tracked"
                  name="Tracked"
                  stackId="cost"
                  fill="var(--primary)"
                />
                <Bar
                  dataKey="reserved"
                  name="Reserved"
                  stackId="cost"
                  fill="var(--muted-foreground)"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>{data.requestCount} requests</span>
          <span>{data.measuredRequests} with measured usage</span>
          <span>{data.reservedRequests} awaiting usage</span>
          <span>{data.uncertainRequests} uncertain</span>
          {data.projectedUsd !== null && (
            <span>
              Month-end estimate: {usd(data.projectedUsd)} (current pace)
            </span>
          )}
        </div>
        {data.byModel.map((model) => (
          <div
            key={model.model}
            className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs"
          >
            <span className="break-all">{model.model}</span>
            <span className="tabular-nums text-muted-foreground">
              {model.requests} requests · {usd(model.spentUsd)} tracked ·{' '}
              {usd(model.heldUsd)} reserved
            </span>
          </div>
        ))}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Only this app’s API calls are controlled here. Costs are calculated
          from reported tokens and recorded prices, not an OpenAI invoice.
          Timeouts keep their allowance reserved.{' '}
          {data.legacyRequests > 0
            ? `${data.legacyRequests} earlier requests have no token records and use conservative reservations. `
            : ''}
          Manual categorization and bank imports remain available when AI
          pauses.
        </p>
      </CardContent>
    </Card>
  );
}
