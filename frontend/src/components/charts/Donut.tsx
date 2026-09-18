// A ring: how one figure divides into parts. Like BarSeries this module is one
// of the two that import Recharts, and screens load it lazily
// (`lazy(() => import('@/components/charts/Donut'))`) so chart code never
// reaches the entry chunk. Styling follows frontend/DESIGN.md: series take
// `chart-1` … `chart-6` as CSS variables, the legend is text with a colour dot
// and the share, the tooltip is a small card carrying the exact figure.
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

export type DonutSlice = {
  /** Identity of the slice; handed back by `onSelect`. */
  key: string;
  label: string;
  /** Plotted magnitude in major units; negatives are clamped to zero. */
  value: number;
  /** The exact figure for the tooltip, already formatted by lib/format. */
  detail: string;
  /** A chart token, 1–6; defaults to the position in the list. */
  tone?: number;
  /** A second pass through the six tokens, drawn lighter. */
  dim?: boolean;
  /** Slices that are a bucket rather than one thing cannot be selected. */
  fixed?: boolean;
};

export type DonutProps = {
  slices: DonutSlice[];
  /** A slice and its legend entry become buttons when this is given. */
  onSelect?: (key: string) => void;
  /** What selecting does, for the legend button's label: "Exclude Foo". */
  selectVerb?: string;
  /** Two lines inside the ring: a caption and a figure. */
  center?: { label: string; value: string };
};

// Written out rather than composed, because Tailwind keeps a theme variable
// only when its name appears in the source: `var(--color-chart-${n})` drops
// --color-chart-1 from the stylesheet and the slice comes out black.
const palette = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
];
const toneOf = (slice: DonutSlice, index: number) =>
  palette[((slice.tone ?? index + 1) - 1) % palette.length];
const opacityOf = (slice: DonutSlice, index: number) =>
  (slice.dim ?? index >= 6) ? 0.55 : 1;

export default function Donut({
  slices,
  onSelect,
  selectVerb = 'Hide',
  center,
}: DonutProps) {
  const data = slices.map((slice) => ({
    ...slice,
    value: Math.max(0, slice.value),
  }));
  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  const share = (value: number) =>
    total ? `${Math.round((value / total) * 1000) / 10}%` : '0%';
  const pick = (slice: DonutSlice) => {
    if (onSelect && !slice.fixed) onSelect(slice.key);
  };
  return (
    <div className="space-y-2">
      <div className="relative h-40">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="var(--color-card)"
              strokeWidth={2}
              isAnimationActive={false}
              onClick={(_, index) => pick(data[index])}
            >
              {data.map((slice, index) => (
                <Cell
                  key={slice.key}
                  fill={toneOf(slice, index)}
                  fillOpacity={opacityOf(slice, index)}
                  cursor={onSelect && !slice.fixed ? 'pointer' : 'default'}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                const slice = payload?.[0]?.payload as DonutSlice | undefined;
                return active && slice ? (
                  <div className="min-w-32 rounded-lg border bg-card px-3 py-2 text-xs shadow-xs">
                    <p className="mb-1 flex items-center gap-1.5">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: toneOf(
                            slice,
                            data.findIndex((s) => s.key === slice.key),
                          ),
                        }}
                      />
                      {slice.label}
                    </p>
                    <p className="flex items-center justify-between gap-4 tabular-nums">
                      <span className="font-medium">{slice.detail}</span>
                      <span className="text-muted-foreground">
                        {share(slice.value)}
                      </span>
                    </p>
                  </div>
                ) : null;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {center && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-xs text-muted-foreground">
              {center.label}
            </span>
            <span className="text-sm font-medium tabular-nums">
              {center.value}
            </span>
          </div>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {data.map((slice, index) => {
          const dot = (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{
                background: toneOf(slice, index),
                opacity: opacityOf(slice, index),
              }}
            />
          );
          const text = (
            <>
              <span className="truncate" title={slice.label}>
                {slice.label}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {share(slice.value)}
              </span>
            </>
          );
          return (
            <li key={slice.key} className="min-w-0 max-w-full">
              {onSelect && !slice.fixed ? (
                <button
                  type="button"
                  onClick={() => pick(slice)}
                  title={`${selectVerb} ${slice.label}`}
                  className="flex min-w-0 items-center gap-1.5 rounded-md hover:text-foreground/70"
                >
                  {dot}
                  {text}
                </button>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  {dot}
                  {text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
