import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Nothing to show, said once, with the one thing to do about it. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {text && (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {text}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
