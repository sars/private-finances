// The only module that imports Recharts; screens load it lazily
// (`lazy(() => import('@/components/charts/BarSeries'))`), so chart code never
// reaches the entry chunk. Styling follows frontend/DESIGN.md: no axis or tick
// lines, a dashed hairline grid, muted ticks, bars at most 28 px with a 4 px
// radius, tooltip as a small card.
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { compact } from '@/lib/format';

export type Row = Record<string, string | number>;
export type BarSeriesProps = {
  data: Row[];
  /** Key of the x value. */
  index: string;
  /** Keys of the series, drawn in order; more than one stacks. */
  series: Array<{ key: string; label: string }>;
  /** Formats a series value for the tooltip; the row is there so exact minor
   *  units can be shown instead of the plotted number. */
  formatValue: (value: number, key: string, row: Row) => string;
  /** Formats an x value for the axis; defaults to the raw value. */
  formatIndex?: (value: string) => string;
  /** Formats the tooltip heading; defaults to formatIndex. */
  formatHeading?: (value: string) => string;
  /** Hidden on the phone by the caller; see DESIGN.md. */
  showYAxis?: boolean;
  minTickGap?: number;
  /** A horizontal rule, such as the average bucket, with its label. */
  reference?: { value: number; label: string };
  /** Index values whose background is shaded, such as weekend days. */
  shaded?: (index: string) => boolean;
};

const palette = [
  'var(--color-primary)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];

export default function BarSeries({
  data,
  index,
  series,
  formatValue,
  formatIndex = String,
  formatHeading,
  showYAxis = true,
  minTickGap = 28,
  reference,
  shaded,
}: BarSeriesProps) {
  const heading = formatHeading ?? formatIndex;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        <CartesianGrid
          vertical={false}
          stroke="var(--color-border)"
          strokeDasharray="3 3"
        />
        {shaded &&
          data
            .filter((row) => shaded(String(row[index])))
            .map((row) => (
              <ReferenceArea
                key={`shade-${String(row[index])}`}
                x1={row[index]}
                x2={row[index]}
                fill="var(--color-muted)"
                fillOpacity={0.6}
                strokeOpacity={0}
              />
            ))}
        {reference && (
          <ReferenceLine
            y={reference.value}
            stroke="var(--color-foreground)"
            strokeDasharray="4 4"
            strokeOpacity={0.5}
            label={{
              value: reference.label,
              position: 'insideTopRight',
              fontSize: 11,
              fill: 'var(--color-muted-foreground)',
            }}
          />
        )}
        <XAxis
          dataKey={index}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(value) => formatIndex(String(value))}
          minTickGap={minTickGap}
          dy={8}
        />
        {showYAxis && (
          <YAxis
            axisLine={false}
            tickLine={false}
            width={52}
            tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
            tickFormatter={(value) => compact(Number(value))}
          />
        )}
        <Tooltip
          cursor={{ fill: 'var(--color-muted)', opacity: 0.6 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="min-w-32 rounded-lg border bg-card px-3 py-2 text-xs shadow-xs">
                <p className="mb-1.5 text-muted-foreground">
                  {heading(String(label))}
                </p>
                {payload.map((entry) => (
                  <p
                    key={String(entry.dataKey)}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: entry.color }}
                      />
                      {series.find((s) => s.key === entry.dataKey)?.label ??
                        String(entry.dataKey)}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatValue(
                        Number(entry.value),
                        String(entry.dataKey),
                        entry.payload as Row,
                      )}
                    </span>
                  </p>
                ))}
              </div>
            ) : null
          }
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={series.length > 1 ? 'stack' : undefined}
            fill={palette[i % palette.length]}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
