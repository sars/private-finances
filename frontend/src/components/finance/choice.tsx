import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type ChoiceOption = { value: string; label: string; disabled?: boolean };

/**
 * One value out of a short list. The single place screens pick from a menu:
 * Base UI's Select shows the raw value in its trigger unless it is handed the
 * labels, and reports `null` when cleared; this hands over the labels and
 * never calls back with nothing.
 */
export function Choice({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
  size,
  placeholder,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  /** Shown while `value` matches no option. */
  placeholder?: string;
  'aria-label'?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      items={options.map(({ value, label }) => ({ value, label }))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={className}
        size={size}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
