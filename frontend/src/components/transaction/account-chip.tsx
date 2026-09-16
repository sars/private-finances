import { Banknote, CreditCard, Landmark } from 'lucide-react';
import { accountIdentity, accountToneClasses } from '@/lib/account-identity';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const icons = { card: CreditCard, bank: Landmark, cash: Banknote };

/** Which of the household's accounts paid, recognisable without reading. */
export function AccountChip({
  source,
  currency,
  label,
  className,
}: {
  source: string | undefined;
  currency: string;
  label: string | null | undefined;
  className?: string;
}) {
  const identity = accountIdentity(source, currency, label);
  const Icon = icons[identity.icon];
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
          <span
            aria-hidden="true"
            className={cn(
              'flex size-6 items-center justify-center rounded-full',
              accountToneClasses[identity.tone],
            )}
          >
            <Icon className="size-3.5" />
          </span>
          <span className="font-medium">{identity.name}</span>
        </TooltipTrigger>
        <TooltipContent>{identity.detail || identity.name}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
