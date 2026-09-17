import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Money } from './money';

/** "+12.3%" against the previous period, or null when there is nothing to compare. */
export function percentChange(current: string, previous: string | null) {
  if (previous === null) return null;
  const now = BigInt(current),
    before = BigInt(previous);
  if (before === 0n) return null;
  const abs = before < 0n ? -before : before;
  // One decimal, computed in integers so the figure is exact.
  const tenths = ((now - before) * 1000n) / abs;
  const sign = tenths > 0n ? '+' : tenths < 0n ? '−' : '';
  const magnitude = tenths < 0n ? -tenths : tenths;
  return `${sign}${magnitude / 10n}.${magnitude % 10n}%`;
}

/**
 * One figure the way the Tremor dashboard shows it: the label, the amount,
 * the change against the previous period and what that period's figure was.
 * The whole card is a link when the figure has payments behind it.
 */
export function KpiCard({
  label,
  minor,
  currency,
  previousMinor = null,
  higherIsWorse = true,
  note,
  href,
  icon: Icon,
  previousLabel = 'the period before',
}: {
  label: string;
  minor: string;
  currency: string;
  /** The same figure for the period before; enables the delta. */
  previousMinor?: string | null;
  /** What the previous figure is, when it is not simply the period before. */
  previousLabel?: string;
  /** Spending going up is the bad direction; a balance going up is not. */
  higherIsWorse?: boolean;
  note?: string;
  href?: string;
  icon?: LucideIcon;
}) {
  const change = percentChange(minor, previousMinor);
  const up = previousMinor !== null && BigInt(minor) > BigInt(previousMinor);
  const down = previousMinor !== null && BigInt(minor) < BigInt(previousMinor);
  const tone = !change
    ? 'text-muted-foreground'
    : (up && higherIsWorse) || (down && !higherIsWorse)
      ? 'text-negative'
      : up || down
        ? 'text-positive'
        : 'text-muted-foreground';
  const body = (
    <CardContent className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <Money
          minor={minor}
          currency={currency}
          className="text-2xl font-semibold tracking-tight break-all"
        />
        {change && (
          <span className={cn('text-xs font-medium', tone)}>{change}</span>
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {previousMinor !== null ? (
          <>
            from <Money minor={previousMinor} currency={currency} />{' '}
            {previousLabel}
          </>
        ) : (
          note
        )}
      </p>
    </CardContent>
  );
  return href ? (
    <a
      href={href}
      className="block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="gap-0 py-0 shadow-xs transition-colors hover:bg-muted/40">
        {body}
      </Card>
    </a>
  ) : (
    <Card className="gap-0 py-0 shadow-xs">{body}</Card>
  );
}
