import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { periodRange } from '@/lib/spending-period';

export type Period = { from: string; to: string };

/** The presets every analytical screen offers, in this order. */
export const periodPresets = [
  { key: 'month', label: 'This month' },
  { key: 'previous', label: 'Last month' },
  { key: 'year', label: '2026 so far' },
  { key: 'archive', label: '2025 archive' },
] as const;

export function presetPeriod(key: string): Period {
  const [from, to] = periodRange(key);
  return { from: from!, to: to! };
}

function shift(day: string, days: number) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The stretch of the same length that ends the day before this one. */
export function previousPeriod({ from, to }: Period): Period | null {
  if (!from || !to || from > to) return null;
  const days =
    Math.round(
      (Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) /
        86_400_000,
    ) + 1;
  const previousTo = shift(from, -1);
  return { from: shift(previousTo, -(days - 1)), to: previousTo };
}

/**
 * Presets as a segmented control, a custom range behind one button. Dates are
 * Riga calendar days, the grammar every endpoint already speaks.
 */
export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (period: Period) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const active = periodPresets.find((p) => {
    const range = presetPeriod(p.key);
    return range.from === value.from && range.to === value.to;
  });
  const invalid = Boolean(draft.from && draft.to && draft.from > draft.to);
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1"
      aria-label="Reporting period"
    >
      {periodPresets.map((preset) => (
        <Button
          key={preset.key}
          size="sm"
          variant={active?.key === preset.key ? 'secondary' : 'ghost'}
          aria-pressed={active?.key === preset.key}
          onClick={() => onChange(presetPeriod(preset.key))}
        >
          {preset.label}
        </Button>
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setDraft(value);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant={active ? 'ghost' : 'secondary'}
              aria-pressed={!active}
            />
          }
        >
          <CalendarDays />
          {active
            ? 'Custom…'
            : `${value.from || 'Start'} – ${value.to || 'Today'}`}
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-3" align="end">
          <div className="grid gap-1.5">
            <Label htmlFor="period-from">From</Label>
            <Input
              id="period-from"
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="period-to">Through</Label>
            <Input
              id="period-to"
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
          {invalid && (
            <p role="alert" className="text-xs text-destructive">
              Choose an end date on or after the start date.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Calendar days in Europe/Riga.
          </p>
          <Button
            size="sm"
            className="w-full"
            disabled={invalid}
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
