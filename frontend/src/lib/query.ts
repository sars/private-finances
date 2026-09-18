import { QueryClient, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
export type Session = {
  actor: 'rodion' | 'katya';
  csrf: string;
  mode: string;
  isAdmin?: boolean;
  /** The commit the server is running; the app compares its own against it. */
  release?: string;
  features: { ai: boolean; telegram: boolean };
  reviewDefaults?: {
    hideNonPersonal: boolean;
    hideInternalTransfers: boolean;
    hideRefunds: boolean;
    hideZeroAmount: boolean;
  };
};
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
      retry: false,
    },
    mutations: { retry: false },
  },
});
/**
 * Thrown only when the server said 401. The shell shows the sign-in screen for
 * this and nothing else: a 503 during a deployment must not put up a password
 * field that cannot possibly help.
 */
export class NotSignedIn extends Error {}
let authorizationLost = false;
export function observeSession(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const next = value as Session;
  if (
    !['rodion', 'katya'].includes(next.actor) ||
    typeof next.csrf !== 'string' ||
    !next.features
  )
    return;
  const previous = queryClient.getQueryData<Session>(['session']);
  if (previous?.actor && previous.actor !== next.actor) {
    void queryClient.cancelQueries({
      predicate: (q) => q.queryKey[0] !== 'session',
    });
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== 'session',
    });
  }
  authorizationLost = false;
  queryClient.setQueryData(['session'], next);
}
export async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (authorizationLost && url !== '/api/bootstrap')
    throw new NotSignedIn('Your session needs attention. Reload to sign in.');
  const response = await fetch(url, {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 401 && !authorizationLost) {
      authorizationLost = true;
      queryClient.removeQueries({
        predicate: (q) => q.queryKey[0] !== 'session',
      });
    }
    if (response.status === 401)
      throw new NotSignedIn('Your session needs attention. Reload to sign in.');
    throw new Error(
      `Could not load this view (${response.status}). Please retry.`,
    );
  }
  const data = (await response.json()) as T;
  if (url === '/api/bootstrap') observeSession(data);
  return data;
}
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => apiGet<Session>('/api/bootstrap', signal),
  });
}
export async function signOut(csrf: string): Promise<void> {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });
  } finally {
    // Reloading is the one certain way to leave no figure behind in a cache,
    // and the shell comes straight back as the sign-in screen.
    window.location.reload();
  }
}
/**
 * Most screens read through the query cache above, and invalidating it is all
 * they need. Nine older screens — Home, Bank connections, Currency conversion,
 * System health, Accounts, Categories & rules, Reports, a payment's history and
 * the AI budget — were written before the cache existed: each fetches inside an
 * effect and re-runs that effect when a number it depends on changes. This is
 * that number, shared by all of them, so one refresh reaches every screen
 * instead of only the newer half.
 */
let refreshSignal = 0;
const refreshListeners = new Set<() => void>();
const subscribeToRefresh = (listener: () => void) => {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
};
/** Put this in an effect's dependencies to re-read when the data goes stale. */
export function useRefreshSignal() {
  return useSyncExternalStore(
    subscribeToRefresh,
    () => refreshSignal,
    () => refreshSignal,
  );
}
/**
 * Everything the household's money is described by is stale: re-read it. Called
 * after a save, when an installed app comes back from the background, from the
 * pull-down gesture on a phone and from the Refresh button on a desktop. The
 * promise settles when the cached queries have answered; a hand-rolled screen
 * puts its own skeleton up in the meantime.
 */
export function invalidateFinancialData() {
  refreshSignal += 1;
  for (const listener of refreshListeners) listener();
  return queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] !== 'session',
  });
}
