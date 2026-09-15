import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';
import { stringSearch } from './navigation-state';
export function useUrlSearch() {
  return useRouterState({
    select: (state) => stringSearch(state.location.search),
    structuralSharing: true,
  });
}
export function useSearchPatch() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Record<string, string | undefined>, replace = false) => {
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => {
          const next = stringSearch(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete next[key];
            else next[key] = value;
          }
          return next;
        },
        replace,
        resetScroll: false,
      });
    },
    [navigate],
  );
}

export function useUrlField(
  key: string,
  fallback: string,
  replace = false,
): [string, (value: string) => void] {
  const search = useUrlSearch();
  const patch = useSearchPatch();
  const set = useCallback(
    (value: string) => patch({ [key]: value }, replace),
    [key, patch, replace],
  );
  return [search[key] ?? fallback, set];
}
