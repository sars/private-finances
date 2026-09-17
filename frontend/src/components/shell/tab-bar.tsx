import { useRouterState } from '@tanstack/react-router';
import { Ellipsis } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { tabScreens } from './navigation';

/** Bottom navigation on the phone: the four everyday screens, then everything. */
export function TabBar({
  counts = {},
}: {
  /** A number on a tab, by href: what is waiting there. */
  counts?: Record<string, number | undefined>;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
  const item =
    'flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium';
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {tabScreens.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <a
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              item,
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <span className="relative">
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
              {counts[href] ? (
                <span className="absolute -top-1.5 -right-3 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums">
                  {counts[href]! > 99 ? '99+' : counts[href]}
                </span>
              ) : null}
            </span>
            {label === 'Spending analytics' ? 'Analytics' : label}
          </a>
        );
      })}
      <button
        type="button"
        onClick={() => setOpenMobile(true)}
        className={cn(item, 'text-muted-foreground')}
      >
        <Ellipsis className="size-5" strokeWidth={1.8} />
        More
      </button>
    </nav>
  );
}
