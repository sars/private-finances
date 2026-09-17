import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
// Vite replaces dist/frontend; use Node's type stripping for the pure helper.
const { isAppPath, reviewSearch, stringSearch, validDisplay } = await import(
  new URL('../../frontend/src/lib/navigation-state.ts', import.meta.url).href
);

test('workspace navigation only intercepts owned screens and validates scalar URL state', () => {
  assert.equal(isAppPath('/receipts'), true);
  assert.equal(isAppPath('/transactions'), true);
  assert.equal(isAppPath('/review'), true);
  assert.equal(
    isAppPath('/transactions/12345678-1234-1234-1234-123456789012/history'),
    true,
  );
  for (const path of [
    '/connections/enablebanking/start',
    '/api/receipts',
    '/receipts/attach',
    '//external.test',
  ])
    assert.equal(isAppPath(path), false);
  assert.deepEqual(
    stringSearch({
      all: 1,
      flag: false,
      display: 'EUR',
      invalid: { nested: true },
    }),
    { all: '1', flag: 'false', display: 'EUR' },
  );
  assert.equal(validDisplay('EUR'), 'EUR');
  assert.equal(validDisplay('AAA'), undefined);
  assert.equal(
    reviewSearch({ window: 'bad', all: 'bad' }).window,
    'current_month',
  );
  assert.equal(
    reviewSearch({ all: '0', window: 'all', id: 'test', includeRefunds: '0' })
      .all,
    '0',
  );
});

test('router preserves transaction filters and currency through detail open, Back and Forward', async () => {
  const root = createRootRoute({ validateSearch: stringSearch });
  const review = createRoute({ getParentRoute: () => root, path: '/review' });
  const history = createMemoryHistory({
    initialEntries: [
      '/review?all=0&window=previous_month&display=EUR&q=dining',
    ],
  });
  const router = createRouter({
    routeTree: root.addChildren([review]),
    history,
  });
  await router.load();
  await router.navigate({
    to: '/review',
    search: { ...router.state.location.search, id: 'payment' },
    resetScroll: false,
  });
  assert.equal(router.state.location.search.id, 'payment');
  assert.equal(router.state.location.search.display, 'EUR');
  history.back();
  await router.load();
  assert.equal(router.state.location.search.id, undefined);
  assert.equal(router.state.location.search.q, 'dining');
  history.forward();
  await router.load();
  assert.equal(router.state.location.search.id, 'payment');
});

test('memory query cache isolates owners and display currencies without repeat reads', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  let calls = 0;
  const fetch = (owner: string, currency: string) =>
    client.fetchQuery({
      queryKey: ['review', owner, { currency }],
      queryFn: async () => {
        calls++;
        return `${owner}:${currency}`;
      },
    });
  assert.equal(await fetch('rodion', 'EUR'), 'rodion:EUR');
  await fetch('rodion', 'EUR');
  assert.equal(calls, 1);
  assert.equal(await fetch('katya', 'EUR'), 'katya:EUR');
  await fetch('rodion', 'UAH');
  assert.equal(calls, 3);
  await client.invalidateQueries({ queryKey: ['review', 'rodion'] });
  await fetch('rodion', 'EUR');
  assert.equal(calls, 4);
  client.clear();
});

test('session changes discard another owner’s cached finances and authorization loss cannot loop requests', async () => {
  const { queryClient, observeSession, apiGet } = await import(
    new URL('../../frontend/src/lib/query.ts', import.meta.url).href
  );
  const session = {
    actor: 'rodion',
    csrf: 'synthetic',
    mode: 'demo',
    features: { ai: false, telegram: false },
  };
  const originalFetch = globalThis.fetch;
  try {
    observeSession(session);
    queryClient.setQueryData(['review', 'rodion'], { private: 'synthetic' });
    observeSession({ ...session, actor: 'katya' });
    assert.equal(queryClient.getQueryData(['review', 'rodion']), undefined);
    assert.equal(queryClient.getQueryData(['session']).actor, 'katya');
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{}', { status: 401 });
    };
    queryClient.setQueryData(['review', 'katya'], { private: 'synthetic' });
    await assert.rejects(apiGet('/api/review'), /session needs attention/);
    await assert.rejects(apiGet('/api/review'), /session needs attention/);
    assert.equal(calls, 1);
    assert.equal(queryClient.getQueryData(['review', 'katya']), undefined);
    const options = queryClient.getDefaultOptions().queries;
    assert.equal(options.refetchOnWindowFocus, false);
    assert.equal(options.refetchOnReconnect, false);
    assert.equal(options.refetchInterval, false);
  } finally {
    globalThis.fetch = originalFetch;
    observeSession(session);
    queryClient.clear();
  }
});
