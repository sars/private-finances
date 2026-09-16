import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { visibleGroups } from './navigation';

/** ⌘K: jump to any screen by name. Loaded lazily by the shell. */
export default function CommandMenu({
  open,
  onOpenChange,
  isAdmin,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  onNavigate: (href: string) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      title="Go to"
      description="Type a screen name"
    >
      <CommandInput placeholder="Go to…" />
      <CommandList>
        <CommandEmpty>No screen matches.</CommandEmpty>
        {visibleGroups(isAdmin).map((group) => (
          <CommandGroup key={group.label} heading={group.label}>
            {group.items.map(({ href, label, icon: Icon }) => (
              <CommandItem
                key={href}
                value={label}
                onSelect={() => {
                  onOpenChange(false);
                  onNavigate(href);
                }}
              >
                <Icon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
