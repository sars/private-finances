import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

/** An amount in minor units, formatted once, always in tabular figures. */
export function Money({
  minor,
  currency,
  signed = false,
  className,
}: {
  minor: string;
  currency: string;
  /** Prefix a plus sign on money coming in. */
  signed?: boolean;
  className?: string;
}) {
  const value = BigInt(minor);
  return (
    <span className={cn('tabular-nums', className)}>
      {signed && value > 0n ? '+' : ''}
      {money(minor, currency)}
    </span>
  );
}
