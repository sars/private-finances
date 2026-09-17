import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useRouter,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient, useSession } from './lib/query';
import { isAppPath, stringSearch } from './lib/navigation-state';
import {
  DisplayCurrencyProvider,
  CurrencyControl,
} from './lib/display-currency';
import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { CircleHelp, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/shell/app-sidebar';
import { useReviewCount } from './lib/payments';
import { TabBar } from '@/components/shell/tab-bar';
import './index.css';

const Cash = lazy(() => import('./Cash'));
const Settings = lazy(() => import('./Settings'));
const Receipts = lazy(() => import('./Receipts'));
const Categories = lazy(() => import('./Categories'));
const Review = lazy(() => import('./Review'));
const Transactions = lazy(() => import('./Transactions'));
const Payment = lazy(() => import('./Payment'));
const Operations = lazy(() => import('./Operations'));
const Fx = lazy(() => import('./Fx'));
const Analytics = lazy(() => import('./Analytics'));
const Overview = lazy(() => import('./Overview'));
const History = lazy(() => import('./History'));
const Accounts = lazy(() => import('./Accounts'));
const Reports = lazy(() => import('./Reports'));
const Connections = lazy(() => import('./Connections'));
const Imports = lazy(() => import('./Imports'));
const screens: Record<
  string,
  React.LazyExoticComponent<React.ComponentType>
> = {
  '/': Overview,
  '/analytics': Analytics,
  '/review': Review,
  '/transactions': Transactions,
  '/cash': Cash,
  '/receipts': Receipts,
  '/categories': Categories,
  '/ops': Operations,
  '/fx': Fx,
  '/accounts': Accounts,
  '/reports': Reports,
  '/connections': Connections,
  '/imports': Imports,
  '/settings': Settings,
};

type Theme = 'system' | 'light' | 'dark';

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('pf-theme');
      return saved === 'dark' || saved === 'light' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  const { data: identity } = useSession();
  const router = useRouter();

  // Every internal navigation goes through here: the sidebar's plain anchors,
  // the tab bar, the command menu. The display currency travels along so a
  // screen never opens in the wrong one.
  const goTo = useCallback(
    (href: string) => {
      const target = new URL(href, window.location.href);
      const search = Object.fromEntries(target.searchParams);
      if (!search.display) {
        try {
          const value = localStorage.getItem('pf-display-currency');
          if (value) search.display = value;
        } catch {}
      }
      void router.navigate({
        to: target.pathname,
        search,
        hash: target.hash.slice(1),
      });
    },
    [router],
  );
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest?.(
        'a[href]',
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self') ||
        anchor.getAttribute('href')?.startsWith('#')
      )
        return;
      const target = new URL(anchor.href, window.location.href);
      if (
        target.origin !== window.location.origin ||
        !isAppPath(target.pathname)
      )
        return;
      event.preventDefault();
      goTo(anchor.href);
    };
    document.addEventListener('click', follow);
    return () => document.removeEventListener('click', follow);
  }, [goTo]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () =>
      document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || (theme === 'system' && media.matches),
      );
    update();
    media.addEventListener('change', update);
    try {
      localStorage.setItem('pf-theme', theme);
    } catch {}
    return () => media.removeEventListener('change', update);
  }, [theme]);

  const isAdmin = !!identity?.isAdmin;
  // What waits for the signed-in member, shown beside Review everywhere the
  // screens are listed.
  const reviewCount = useReviewCount(identity?.actor);
  const counts = { '/review': reviewCount.data };
  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to main content
      </a>
      <AppSidebar
        isAdmin={isAdmin}
        counts={counts}
        footer={
          <div className="space-y-3 px-2 pb-2">
            <ThemeControl theme={theme} setTheme={setTheme} />
            <div className="flex items-center gap-3 border-t pt-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
                {identity?.actor.slice(0, 1) ?? '—'}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium capitalize">
                  {identity?.actor ?? 'Connecting…'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {identity?.mode === 'demo'
                    ? 'Demo workspace'
                    : 'Private workspace'}
                </div>
              </div>
            </div>
          </div>
        }
      />
      <SidebarInset id="main" className="pb-20 md:pb-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Household workspace · Europe/Riga
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <CurrencyControl />
          </div>
        </header>
        <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
          {identity?.mode === 'demo' && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
              <span>Demo workspace · synthetic examples only</span>
              <form action="/import" method="post">
                <input type="hidden" name="csrf" value={identity.csrf} />
                <Button type="submit" size="sm" variant="outline">
                  Import example transactions
                </Button>
              </form>
            </div>
          )}
          <Suspense
            fallback={
              <div
                role="status"
                className="py-12 text-sm text-muted-foreground"
              >
                Loading your workspace…
              </div>
            }
          >
            <Outlet />
          </Suspense>
          <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t py-5 text-xs text-muted-foreground">
            <span>Private Finances · Household workspace</span>
            <a
              className="inline-flex items-center gap-1.5 hover:text-foreground"
              href="/ops"
            >
              <CircleHelp size={14} />
              Data & system health
            </a>
          </footer>
        </div>
      </SidebarInset>
      <TabBar counts={counts} />
      <Toaster theme="system" position="top-center" closeButton />
    </SidebarProvider>
  );
}

function ThemeControl({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  return (
    <div
      className="inline-flex w-full rounded-lg border bg-background p-1"
      aria-label="Color theme"
    >
      {(
        [
          { value: 'light', label: 'Light mode', icon: Sun },
          { value: 'system', label: 'Follow system theme', icon: Monitor },
          { value: 'dark', label: 'Dark mode', icon: Moon },
        ] as const
      ).map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          size="sm"
          variant={theme === value ? 'secondary' : 'ghost'}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className="flex-1"
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  );
}

class WorkspaceBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="text-xl font-semibold">Unable to open this screen</h1>
        <p className="text-sm text-muted-foreground">
          Please reload the workspace. If this continues, check system health.
        </p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <a className="ml-4 text-sm underline" href="/ops">
          System health
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <DisplayCurrencyProvider>
        <WorkspaceBoundary>
          <App />
        </WorkspaceBoundary>
      </DisplayCurrencyProvider>
    </QueryClientProvider>
  );
}
const rootRoute = createRootRoute({
  component: Root,
  validateSearch: stringSearch,
});
const routes = Object.entries(screens).map(([path, Screen]) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <Screen />,
  }),
);
routes.push(
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions/$id/history',
    component: () => <History />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/transactions/$id',
    component: () => <Payment />,
  }),
);
const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  scrollRestoration: true,
  defaultPreload: false,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
