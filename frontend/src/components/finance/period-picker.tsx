import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { periodRange, rigaToday } from '@/lib/spending-period';

export type Period = { from: string; to: string };

/** The presets every analytical screen offers, in this order. */
export const periodPresets = [
  { key: 'month', label: 'This month' },
  { key: 'previous', label: 'Last month' },
  { key: 'year', label: 'This year' },
  { key: 'archive', label: 'Last year' },
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

// The picker works in calendar days: a Riga day becomes a local Date with
// the same year, month and day, and comes back the same way, so no zone
// arithmetic happens in between.
function toDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}
function toDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const monthName = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
});
const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
});
const shortDayYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
function describe({ from, to }: Period): string {
  if (!from || !to) return 'Choose a period';
  const a = toDate(from),
    b = toDate(to);
  if (
    a.getDate() === 1 &&
    toDay(new Date(b.getFullYear(), b.getMonth() + 1, 0)) === to &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  )
    return monthName.format(a);
  if (from === `${a.getFullYear()}-01-01` && to === `${a.getFullYear()}-12-31`)
    return String(a.getFullYear());
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${(sameYear ? shortDay : shortDayYear).format(a)} – ${shortDayYear.format(b)}`;
}
function wholeMonth(date: Date): Period {
  return {
    from: toDay(new Date(date.getFullYear(), date.getMonth(), 1)),
    to: toDay(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
  };
}

/**
 * One button naming the period; behind it the presets, a calendar to pick any
 * range (two months on desktop, one on the phone, in a bottom sheet there),
 * and a shortcut for the whole month in view. Dates are Riga calendar days,
 * the grammar every endpoint speaks.
 */
export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (period: Period) => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const [month, setMonth] = useState<Date>(() =>
    toDate(value.to || rigaToday()),
  );
  const today = toDate(rigaToday());
  const active = periodPresets.find((p) => {
    const range = presetPeriod(p.key);
    return range.from === value.from && range.to === value.to;
  });
  const start = (next: boolean) => {
    setOpen(next);
    if (next) {
      setDraft(
        value.from && value.to
          ? { from: toDate(value.from), to: toDate(value.to) }
          : undefined,
      );
      setMonth(toDate(value.to || rigaToday()));
    }
  };
  const apply = (period: Period) => {
    onChange(period);
    setOpen(false);
  };
  const shown = wholeMonth(month);
  const draftLabel = draft?.from
    ? draft.to
      ? describe({ from: toDay(draft.from), to: toDay(draft.to) })
      : `${shortDayYear.format(draft.from)} – …`
    : 'Tap a first and a last day';

  const trigger = (
    <Button variant="outline" size="sm" aria-label="Period" className="gap-2">
      <CalendarDays />
      {active ? `${active.label} · ${describe(value)}` : describe(value)}
      <ChevronDown className="opacity-60" />
    </Button>
  );
  const body = (
    <div className="flex flex-col sm:flex-row">
      <div className="flex flex-wrap gap-1 p-2 pr-10 sm:w-44 sm:flex-col sm:border-r sm:pr-2">
        {periodPresets.map((preset) => (
          <Button
            key={preset.key}
            size="sm"
            variant={active?.key === preset.key ? 'secondary' : 'ghost'}
            className="sm:justify-start"
            onClick={() => apply(presetPeriod(preset.key))}
          >
            {preset.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="sm:justify-start"
          onClick={() => apply(shown)}
        >
          All of {monthName.format(month)}
        </Button>
      </div>
      <div className="flex flex-col">
        <Calendar
          mode="range"
          numberOfMonths={isMobile ? 1 : 2}
          captionLayout="dropdown"
          weekStartsOn={1}
          startMonth={new Date(2024, 0)}
          endMonth={today}
          disabled={[{ after: today }]}
          month={month}
          onMonthChange={setMonth}
          selected={draft}
          onSelect={setDraft}
          className="mx-auto"
        />
        <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">{draftLabel}</span>
          <Button
            size="sm"
            disabled={!draft?.from}
            onClick={() =>
              draft?.from &&
              apply({
                from: toDay(draft.from),
                to: toDay(draft.to ?? draft.from),
              })
            }
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
  if (isMobile)
    return (
      <Sheet open={open} onOpenChange={start}>
        <SheetTrigger render={trigger} />
        <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto">
          <SheetHeader className="sr-only">
            <SheetTitle>Period</SheetTitle>
            <SheetDescription>Choose the days to show.</SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  return (
    <Popover open={open} onOpenChange={start}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-auto p-0">
        {body}
      </PopoverContent>
    </Popover>
  );
}
