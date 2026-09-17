import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

export type HeatColumn = { key: string; label: string };
export type HeatRow = {
  key: string;
  label: string;
  /** Minor units per column key; a missing column is zero. */
  cells: Record<string, string>;
  /** Rows shown under this one when it is opened. */
  children?: HeatRow[];
  /** Where a cell leads: the payments behind it. */
  href?: (column: string) => string;
};

/**
 * A grid of figures where darker means more. Rows are what is being compared
 * (categories) and columns are when (months), or the other way round on the
 * phone, where the screen passes them transposed. A row with children opens on
 * tap. The first column stays put while the rest scroll sideways inside the
 * card, never the page.
 */
export function HeatGrid({
  columns,
  rows,
  currency,
  totalLabel = 'Total',
  className,
}: {
  columns: HeatColumn[];
  rows: HeatRow[];
  currency: string;
  totalLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const flat: Array<HeatRow & { depth: number; expandable: boolean }> = [];
  for (const row of rows) {
    const expandable = Boolean(row.children?.length);
    flat.push({ ...row, depth: 0, expandable });
    if (expandable && open.has(row.key))
      for (const child of row.children!)
        flat.push({ ...child, depth: 1, expandable: false });
  }
  let max = 0n;
  for (const row of rows)
    for (const column of columns) {
      const v = BigInt(row.cells[column.key] ?? '0');
      if (v > max) max = v;
    }
  const total = (row: HeatRow) =>
    columns.reduce((n, c) => n + BigInt(row.cells[c.key] ?? '0'), 0n);
  // The currency is in the corner; each cell keeps the number only.
  const short = (minor: string) =>
    money(minor, currency).replace(/\s[A-Z]{3}$/, '');
  const sticky =
    'sticky left-0 z-10 bg-card text-left whitespace-nowrap after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border';
  return (
    <div className={cn('overflow-x-auto rounded-lg border', className)}>
      <Table className="text-xs tabular-nums">
        <TableHeader>
          <TableRow>
            <TableHead className={cn(sticky, 'relative px-3')}>
              {currency}
            </TableHead>
            {columns.map((c) => (
              <TableHead key={c.key} className="px-2 text-right">
                {c.label}
              </TableHead>
            ))}
            <TableHead className="px-3 text-right">{totalLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {flat.map((row) => (
            <TableRow key={row.key}>
              <TableCell
                className={cn(
                  sticky,
                  'relative px-3 font-medium',
                  row.depth ? 'pl-7 font-normal text-muted-foreground' : '',
                )}
              >
                {row.expandable ? (
                  <button
                    type="button"
                    className="inline-flex min-h-7 items-center gap-1"
                    aria-expanded={open.has(row.key)}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (next.has(row.key)) next.delete(row.key);
                        else next.add(row.key);
                        return next;
                      })
                    }
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 text-muted-foreground transition-transform',
                        open.has(row.key) && 'rotate-90',
                      )}
                    />
                    {row.label}
                  </button>
                ) : (
                  row.label
                )}
              </TableCell>
              {columns.map((c) => {
                const minor = row.cells[c.key] ?? '0';
                const share =
                  max === 0n ? 0 : Number((BigInt(minor) * 100n) / max) / 100;
                const content = minor === '0' ? '—' : short(minor);
                const text = cn(
                  'relative z-10',
                  share > 0.55 && 'text-primary-foreground',
                );
                return (
                  <TableCell key={c.key} className="relative px-2 text-right">
                    <span
                      aria-hidden="true"
                      className="absolute inset-0.5 rounded-sm bg-primary"
                      style={{ opacity: share * 0.75 }}
                    />
                    {row.href && minor !== '0' ? (
                      <a href={row.href(c.key)} className={text}>
                        {content}
                      </a>
                    ) : (
                      <span className={text}>{content}</span>
                    )}
                  </TableCell>
                );
              })}
              <TableCell className="px-3 text-right font-medium">
                {short(total(row).toString())}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
