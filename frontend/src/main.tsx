import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useRouterState,
  useRouter,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, useSession } from './lib/query';
import { isAppPath, stringSearch } from './lib/navigation-state';
import {
  DisplayCurrencyProvider,
  CurrencyControl,
} from './lib/display-currency';
import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import {
  Activity,
  ArrowLeftRight,
  ChartNoAxesCombined,
  CircleHelp,
  Landmark,
  LayoutDashboard,
  ListFilter,
  Menu,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useEffect, useState } from 'react';
const Cash = lazy(() => import('./Cash'));
const Settings = lazy(() => import('./Settings'));
const Receipts = lazy(() => import('./Receipts'));
const Categories = lazy(() => import('./Categories'));
const Review = lazy(() => import('./Review'));
const Operations = lazy(() => import('./Operations'));
const Fx = lazy(() => import('./Fx'));
const Analytics = lazy(() => import('./Analytics'));
const Overview = lazy(() => import('./Overview'));
const History = lazy(() => import('./History'));
const Accounts = lazy(() => import('./Accounts'));
const Reports = lazy(() => import('./Reports'));
const Connections = lazy(() => import('./Connections'));
const screens: Record<
  string,
  React.LazyExoticComponent<React.ComponentType>
> = {
  '/': Overview,
  '/analytics': Analytics,
  '/review': Review,
  '/cash': Cash,
  '/receipts': Receipts,
  '/categories': Categories,
  '/ops': Operations,
  '/fx': Fx,
  '/accounts': Accounts,
  '/reports': Reports,
  '/connections': Connections,
  '/settings': Settings,
};
import './index.css';

const navigation = [
  { href: '/', label: 'Home', icon: LayoutDashboard },
  {
    href: '/analytics',
    label: 'Spending analytics',
    icon: ChartNoAxesCombined,
  },
  { href: '/receipts', label: 'Receipts', icon: ListFilter },
  { href: '/review', label: 'Transactions', icon: ListFilter },
  { href: '/accounts', label: 'Accounts & exclusions', icon: Wallet },
  { href: '/reports', label: 'Reports', icon: ChartNoAxesCombined },
  { href: '/categories', label: 'Categories & rules', icon: ArrowLeftRight },
  { href: '/fx', label: 'Currency conversion', icon: Landmark },
  { href: '/connections', label: 'Bank connections', icon: ShieldCheck },
  { href: '/ops', label: 'System health', icon: Activity },
];
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
  const [menu, setMenu] = useState(false);
  const { data: identity } = useSession();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
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
      setMenu(false);
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
    };
    document.addEventListener('click', follow);
    return () => document.removeEventListener('click', follow);
  }, [router]);
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
  useEffect(() => {
    const media = matchMedia('(min-width: 1024px)');
    const close = () => {
      if (media.matches) setMenu(false);
    };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background px-4 lg:hidden">
        <a
          href="/"
          className="flex items-center gap-2.5 font-semibold tracking-tight"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Wallet size={18} />
          </span>
          <span className="hidden min-[390px]:inline">Private Finances</span>
          <span className="min-[390px]:hidden">Finances</span>
        </a>
        <div className="flex items-center gap-1">
          <CurrencyControl />
          <Sheet open={menu} onOpenChange={setMenu}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-80 max-w-[90vw] overflow-y-auto p-5"
            >
              <SheetHeader className="px-0">
                <SheetTitle>Private Finances</SheetTitle>
                <SheetDescription>
                  Navigate your household workspace.
                </SheetDescription>
              </SheetHeader>
              <Navigation />
              <div className="mt-6 border-t pt-5">
                <ThemeControl theme={theme} setTheme={setTheme} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-card px-4 py-7 lg:flex">
        <a
          href="/"
          className="mb-9 flex items-center gap-3 px-2 text-[15px] font-semibold tracking-tight"
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Wallet size={20} />
          </span>
          Private Finances
        </a>
        <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">
          Your household
        </div>
        <Navigation />
        <div className="mt-auto space-y-5 px-2">
          <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              Private workspace
              <br />
              Your financial data stays yours.
            </span>
          </div>
          <ThemeControl theme={theme} setTheme={setTheme} />
          <div className="flex items-center gap-3 border-t pt-4">
            <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
              {identity?.actor.slice(0, 1) ?? '—'}
            </span>
            <div>
              <div className="text-sm font-medium capitalize">
                {identity?.actor ?? 'Connecting…'}
              </div>
              <div className="text-xs text-muted-foreground">
                {identity?.mode === 'demo'
                  ? 'Demo workspace'
                  : 'Personal workspace'}
              </div>
            </div>
          </div>
        </div>
      </aside>
      <main
        id="main"
        className="mx-auto max-w-[1800px] px-4 py-6 sm:px-7 sm:py-8 lg:ml-60 lg:px-10 xl:px-12"
      >
        <>
          <div className="mb-6 hidden items-center justify-between border-b pb-4 lg:flex">
            <span className="text-xs text-muted-foreground">
              Household workspace · Europe/Riga
            </span>
            <CurrencyControl />
          </div>
          {identity?.mode === 'demo' && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
              <span>Demo workspace · synthetic examples only</span>
              <form action="/import" method="post">
                <input type="hidden" name="csrf" value={identity.csrf} />
                <Button size="sm" variant="outline">
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
        </>
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
      </main>
    </div>
  );
}
function Navigation() {
  const { data: session } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Main navigation" className="space-y-1">
      {[
        ...navigation,
        ...(session?.isAdmin
          ? [{ href: '/settings', label: 'Settings', icon: ShieldCheck }]
          : []),
      ].map(({ href, label, icon: Icon }) => (
        <a
          key={href}
          href={href}
          aria-current={href === pathname ? 'page' : undefined}
          className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors ${href === pathname ? 'bg-primary/8 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        >
          <Icon className="size-[18px]" strokeWidth={1.7} />
          {label}
        </a>
      ))}
    </nav>
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
      className="inline-flex rounded-lg border bg-background p-1"
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
          className="h-8 w-11"
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
