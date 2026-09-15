import * as React from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { searchMatch } from '@/lib/search-match';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export type ComboboxOption = {
  value: string;
  label: string;
  /**
   * What the closed field shows once this is chosen. A list entry can lean on
   * its group heading for context, but the field standing alone cannot, so a
   * category reads "Groceries" under Food and "Food / Groceries" once picked.
   */
  display?: string;
  /** Options carrying the same group are listed together under its heading. */
  group?: string;
  hint?: string;
  keywords?: string[];
};

function grouped(options: ComboboxOption[]) {
  const groups = new Map<string, ComboboxOption[]>();
  for (const option of options) {
    const key = option.group ?? '';
    const list = groups.get(key);
    if (list) list.push(option);
    else groups.set(key, [option]);
  }
  return [...groups.entries()];
}

function Options({
  options,
  selected,
  onPick,
}: {
  options: ComboboxOption[];
  selected: (value: string) => boolean;
  onPick: (value: string) => void;
}) {
  return (
    <>
      {grouped(options).map(([group, items]) => (
        <CommandGroup key={group || 'ungrouped'} heading={group || undefined}>
          {items.map((option) => (
            <CommandItem
              key={option.value}
              value={option.value}
              keywords={option.keywords}
              onSelect={() => onPick(option.value)}
            >
              <Check
                className={cn(
                  'size-4 shrink-0',
                  selected(option.value) ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              {option.hint && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {option.hint}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  );
}

/**
 * A single-select field that filters as you type. A long category tree is not
 * browsable in a plain dropdown, and a bare text input gives no clue what the
 * valid names are; this shows both at once.
 */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder = 'Choose an option',
  searchPlaceholder = 'Type to search…',
  emptyText = 'Nothing matches.',
  empty,
  disabled = false,
  invalid = false,
  className,
}: {
  id?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Shown instead of `emptyText` when nothing matches, for a way out. */
  empty?: React.ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const current = options.find((option) => option.value === value);
  const pick = (next: string) => {
    onChange(next);
    setQuery('');
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className={cn(
            'h-auto min-h-9 w-full justify-between gap-2 py-2 font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <span className="min-w-0 flex-1 text-left break-words whitespace-normal">
            {current?.display ?? current?.label ?? value ?? ''}
            {!value && placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command filter={searchMatch}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{empty ?? emptyText}</CommandEmpty>
            <Options
              options={options}
              selected={(option) => option === value}
              onPick={pick}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The same control for a set of values, as tags are. */
export function MultiCombobox({
  id,
  options,
  values,
  onChange,
  placeholder = 'Add…',
  searchPlaceholder = 'Type to search…',
  emptyText = 'Nothing matches.',
  disabled = false,
  className,
}: {
  id?: string;
  options: ComboboxOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const label = (value: string) =>
    options.find((option) => option.value === value)?.label ?? value;
  const toggle = (next: string) => {
    onChange(
      values.includes(next)
        ? values.filter((value) => value !== next)
        : [...values, next],
    );
    setQuery('');
  };
  return (
    <div className={cn('space-y-2', className)}>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1 py-1">
              <span className="break-words whitespace-normal">
                {label(value)}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${label(value)}`}
                className="rounded-full opacity-60 hover:opacity-100"
                onClick={() =>
                  onChange(values.filter((current) => current !== value))
                }
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between gap-2 font-normal text-muted-foreground"
          >
            {placeholder}
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-0"
        >
          <Command filter={searchMatch}>
            <CommandInput
              placeholder={searchPlaceholder}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <Options
                options={options}
                selected={(option) => values.includes(option)}
                onPick={toggle}
              />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
