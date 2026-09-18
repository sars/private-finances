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
  hideLabel = false,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /**
   * Keep the label for a screen reader but take it off the screen, for a
   * control that already reads as its own label — a button saying "This year ·
   * 1 Jan – 18 Sept 2026" does not need the word "Period" above it. A stacked
   * label costs about 24px of height each, which is what pushed the first row
   * of controls a band below the page description.
   */
  hideLabel?: boolean;
}) {
  return (
    <div className={cn('min-w-36 flex-1 sm:flex-none', className)}>
      <label
        htmlFor={htmlFor}
        className={cn(
          'block text-xs font-medium text-muted-foreground',
          hideLabel ? 'sr-only' : 'mb-1.5',
        )}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
