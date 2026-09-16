import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Money } from './money';

export type TreeRow = {
  id: string;
  parentId: string | null;
  name: string;
  minor: string;
  count: number;
  /** Payments that had no rate and are missing from `minor`. */
  missingFx?: number;
  href?: string;
};

/**
 * A rolled-up tree: every branch shows its total, opens to its children, and
 * each row links to the payments behind it. Card rows, not a table, so it
 * reads at 390 px.
 */
export function TreeTable({
  rows,
  currency,
  className,
}: {
  rows: TreeRow[];
  currency: string;
  className?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const children = new Map<string | null, TreeRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  const bySize = (a: TreeRow, b: TreeRow) =>
    BigInt(a.minor) > BigInt(b.minor)
      ? -1
      : BigInt(a.minor) < BigInt(b.minor)
        ? 1
        : a.name.localeCompare(b.name);
  const render = (parentId: string | null, depth: number) =>
    (children.get(parentId) ?? []).sort(bySize).map((row) => {
      const kids = children.get(row.id)?.length ?? 0;
      const expanded = open.has(row.id);
      return (
        <div key={row.id}>
          <div
            className="flex min-h-10 items-center gap-2 border-b py-1.5 text-sm last:border-b-0"
            style={{ paddingLeft: `${depth * 1.25}rem` }}
          >
            {kids ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={
                  expanded ? `Collapse ${row.name}` : `Expand ${row.name}`
                }
                onClick={() =>
                  setOpen((set) => {
                    const next = new Set(set);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })
                }
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    'size-4 transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
              </button>
            ) : (
              <span className="size-6 shrink-0" />
            )}
            {row.href ? (
              <a
                href={row.href}
                className="min-w-0 flex-1 truncate hover:underline"
                title={row.name}
              >
                {row.name}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate" title={row.name}>
                {row.name}
              </span>
            )}
            <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
              {row.count}
              {row.missingFx ? ` · ${row.missingFx} no rate` : ''}
            </span>
            <Money
              minor={row.minor}
              currency={currency}
              className={cn('shrink-0', depth === 0 && 'font-medium')}
            />
          </div>
          {expanded && render(row.id, depth + 1)}
        </div>
      );
    });
  return <div className={className}>{render(null, 0)}</div>;
}
