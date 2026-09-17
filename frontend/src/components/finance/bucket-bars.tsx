import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

export type BucketBar = {
  key: string;
  label: string;
  minor: string;
  /** The bucket is not over yet, or the period cuts it short. */
  partial?: boolean;
  /** Text after the figure on a partial bucket, such as "to the 17th". */
  note?: string;
  /** One of the heaviest buckets, drawn in the accent. */
  hot?: boolean;
  href?: string;
};

/**
 * One horizontal bar per bucket with the figure written on it, a rule for the
 * average full bucket, the unfinished bucket hatched and the heaviest ones in
 * the accent. It reads on a phone without a legend, which a stacked chart
 * never did; with more than about fourteen buckets a column chart takes over.
 */
export function BucketBars({
  rows,
  currency,
  averageMinor,
  className,
}: {
  rows: BucketBar[];
  currency: string;
  /** The average full bucket; drawn as a rule when given. */
  averageMinor?: string | null;
  className?: string;
}) {
  const max = rows.reduce(
    (m, r) => (BigInt(r.minor) > m ? BigInt(r.minor) : m),
    0n,
  );
  const pct = (minor: string) =>
    max === 0n ? 0 : Number((BigInt(minor) * 1000n) / max) / 10;
  const average = averageMinor ? pct(averageMinor) : null;
  return (
    <div className={cn('space-y-2', className)}>
      {rows.map((row) => {
        const width = pct(row.minor);
        const inside = width > 34;
        const figure = money(row.minor, currency);
        const bar = (
          <div className="grid grid-cols-[3.5rem_1fr] items-center gap-3 sm:grid-cols-[5rem_1fr]">
            <span className="truncate text-xs font-medium text-muted-foreground sm:text-sm">
              {row.label}
            </span>
            <div className="relative h-8 overflow-hidden rounded-md bg-muted">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-l-md',
                  row.partial
                    ? 'bg-[repeating-linear-gradient(115deg,var(--muted-foreground)_0_6px,transparent_6px_12px)] opacity-40'
                    : row.hot
                      ? 'bg-primary'
                      : 'bg-chart-5',
                )}
                style={{ width: `${width}%` }}
              />
              {average !== null && (
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 w-0.5 bg-foreground/60"
                  style={{ left: `${average}%` }}
                />
              )}
              <span
                className={cn(
                  'absolute inset-y-0 flex items-center px-2 text-xs font-medium tabular-nums',
                  inside && !row.partial
                    ? 'text-primary-foreground'
                    : 'text-foreground',
                )}
                style={inside ? { left: 0 } : { left: `${width}%` }}
              >
                {figure}
                {row.note ? (
                  <span className="ml-1 font-normal text-muted-foreground">
                    · {row.note}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        );
        return row.href ? (
          <a
            key={row.key}
            href={row.href}
            className="block rounded-md hover:bg-muted/40"
            aria-label={`${row.label}: ${figure}`}
          >
            {bar}
          </a>
        ) : (
          <div key={row.key}>{bar}</div>
        );
      })}
    </div>
  );
}
