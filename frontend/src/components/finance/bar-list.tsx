import { cn } from '@/lib/utils';
import { Money } from './money';

export type BarListRow = { name: string; minor: string; href?: string };

/**
 * Ranked horizontal bars with the label on the bar and the amount beside it —
 * the breakdown that reads on a phone where a pie or an XY chart does not.
 */
export function BarList({
  rows,
  currency,
  className,
}: {
  rows: BarListRow[];
  currency: string;
  className?: string;
}) {
  const max = rows.reduce((m, r) => {
    const v = BigInt(r.minor);
    return v > m ? v : m;
  }, 0n);
  return (
    <div className={cn('space-y-1.5', className)}>
      {rows.map((row) => {
        const width =
          max > 0n ? Number((BigInt(row.minor) * 10000n) / max) / 100 : 0;
        const label = (
          <span className="truncate" title={row.name}>
            {row.name}
          </span>
        );
        return (
          <div key={row.name} className="flex items-center gap-3 text-sm">
            <div className="relative flex h-8 min-w-0 flex-1 items-center">
              <div
                className="absolute inset-y-0 left-0 rounded bg-primary/15 dark:bg-primary/25"
                style={{ width: `${width}%` }}
              />
              {row.href ? (
                <a
                  href={row.href}
                  className="relative flex min-w-0 px-2 hover:underline"
                >
                  {label}
                </a>
              ) : (
                <span className="relative flex min-w-0 px-2">{label}</span>
              )}
            </div>
            <Money
              minor={row.minor}
              currency={currency}
              className="shrink-0 text-muted-foreground"
            />
          </div>
        );
      })}
    </div>
  );
}
