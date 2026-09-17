import { AccountBadge } from '@/components/finance';
import { accountIdentity } from '@/lib/account-identity';
import type { Owner } from '@/lib/account-visuals';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/** Which of the household's accounts paid, recognisable without reading. */
export function AccountChip({
  source,
  currency,
  label,
  owner,
  className,
}: {
  source: string | undefined;
  currency: string;
  label: string | null | undefined;
  owner?: Owner | null;
  className?: string;
}) {
  const identity = accountIdentity(source, currency, label);
  const mentionsCurrency = identity.name
    .toLocaleUpperCase()
    .includes(currency.toLocaleUpperCase());
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                'inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm',
                className,
              )}
            />
          }
        >
          <AccountBadge
            source={source}
            currency={currency}
            label={label}
            owner={owner}
            size="sm"
          />
          <span className="font-medium">{identity.name}</span>
          {mentionsCurrency ? null : (
            <span className="text-xs font-medium text-muted-foreground">
              {currency}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>{identity.detail || identity.name}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
