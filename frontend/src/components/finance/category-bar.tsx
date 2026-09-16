import { cn } from '@/lib/utils';

export type Segment = {
  label: string;
  /** Any non-negative magnitude; shares are computed from the set. */
  value: number;
  /** A chart token index, 1–6; defaults to the position in the list. */
  tone?: number;
  href?: string;
};

/** One bar split into shares, with a legend that carries the percentages. */
export function CategoryBar({
  segments,
  className,
}: {
  segments: Segment[];
  className?: string;
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  const percent = (value: number) =>
    total ? `${Math.round((value / total) * 1000) / 10}%` : '0%';
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {shown.map((s, i) => (
          <div
            key={s.label}
            className="h-full"
            style={{
              width: `${total ? (s.value / total) * 100 : 0}%`,
              background: `var(--color-chart-${s.tone ?? (i % 6) + 1})`,
            }}
            title={`${s.label} · ${percent(s.value)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {shown.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{
                background: `var(--color-chart-${s.tone ?? (i % 6) + 1})`,
              }}
            />
            {s.href ? (
              <a href={s.href} className="hover:underline">
                {s.label}
              </a>
            ) : (
              <span>{s.label}</span>
            )}
            <span className="tabular-nums text-muted-foreground">
              {percent(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
