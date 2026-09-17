import type { ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { visibleGroups } from './navigation';

export function AppSidebar({
  isAdmin,
  counts = {},
  footer,
}: {
  isAdmin: boolean;
  /** A number beside a screen's name, by href: what is waiting there. */
  counts?: Record<string, number | undefined>;
  footer?: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<a href="/" />}>
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Wallet className="size-4" />
              </span>
              <span className="font-semibold tracking-tight">
                Private Finances
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups(isAdmin).map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map(({ href, label, icon: Icon }) => (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton
                      isActive={pathname === href}
                      render={
                        <a
                          href={href}
                          aria-current={pathname === href ? 'page' : undefined}
                        />
                      }
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                    {counts[href] ? (
                      <SidebarMenuBadge className="rounded-full bg-primary/10 text-primary">
                        {counts[href]}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>{footer}</SidebarFooter>
    </Sidebar>
  );
}
