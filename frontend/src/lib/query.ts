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
    throw new Error('Your session needs attention. Reload to sign in.');
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
    throw new Error(
      response.status === 401
        ? 'Your session needs attention. Reload to sign in.'
        : `Could not load this view (${response.status}). Please retry.`,
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
export function invalidateFinancialData() {
  return queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] !== 'session',
  });
}
