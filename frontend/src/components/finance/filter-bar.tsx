import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A row of labelled controls above a list or chart. */
export function FilterBar({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        'flex flex-wrap items-end gap-4 rounded-lg border bg-card p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One control with its label; sizes itself to a phone column or a desktop cell. */
export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-36 flex-1 sm:flex-none', className)}>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
