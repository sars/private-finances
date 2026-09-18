import { QueryClient, useQuery } from '@tanstack/react-query';
export type Session = {
  actor: 'rodion' | 'katya';
  csrf: string;
  mode: string;
  isAdmin?: boolean;
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
export function invalidateFinancialData() {
  return queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] !== 'session',
  });
}
