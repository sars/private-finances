import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { web, type WebConfig } from '../src/web.js';
import { seedTestOwners, signInAs } from './sign-in.js';

test('spending HTTP controls enforce CSRF, owner boundaries and stale revisions', async () => {
  const db = memoryDatabase();
  await migrate(db);
  const repo = new Repository(db);
  const baseRow = {
    source: 'synthetic',
    accountId: 'account',
    owner: 'rodion',
    currency: 'EUR',
    bookedAt: '2026-07-01T12:00:00Z',
    description: 'Synthetic shop',
  };
  await repo.importBatch([
    { ...baseRow, sourceId: 'debit', amountMinor: '-500' },
    {
      ...baseRow,
      sourceId: 'credit',
      amountMinor: '500',
      bookedAt: '2026-07-02T12:00:00Z',
    },
  ]);
  const rows = await repo.list('rodion');
  const debit = rows.find((r) => r.sourceId === 'debit')!,
    credit = rows.find((r) => r.sourceId === 'credit')!;
  const config: WebConfig = {
    port: 0,
    mode: 'postgres',
    release: 'test',
  };
  const server = web(repo, config, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const cookies: Record<string, string> = { rodion: '', katya: '' };
  const get = (path: string, owner = 'rodion') =>
    fetch(base + path, { headers: { cookie: cookies[owner]! } });
  const post = (
    path: string,
    fields: Record<string, string>,
    owner = 'rodion',
  ) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie: cookies[owner]! },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  try {
    await seedTestOwners(db);
    cookies.rodion = await signInAs(base, 'rodion');
    cookies.katya = await signInAs(base, 'katya');
    const csrf = (await (await get('/api/bootstrap')).json()).csrf;
    const kateCsrf = (await (await get('/api/bootstrap', 'katya')).json()).csrf;
    const fields = {
      id: debit.id,
      revision: '0',
      annotationRevision: '0',
      pattern: 'exceptional',
      reason: 'Owner confirms',
    };
    assert.equal((await post('/spending-pattern', fields)).status, 403);
    // Either member may label the other's payment; the annotation stays on the
    // owner's account and only a payment that does not exist is refused.
    assert.equal(
      (
        await post(
          '/spending-pattern',
          {
            ...fields,
            id: '00000000-0000-4000-8000-000000000000',
            csrf: kateCsrf,
          },
          'katya',
        )
      ).status,
      400,
    );
    assert.equal(
      (await post('/spending-pattern', { ...fields, csrf })).status,
      303,
    );
    assert.equal(
      (await post('/spending-pattern', { ...fields, csrf, pattern: 'routine' }))
        .status,
      409,
    );
    assert.equal((await repo.list('rodion'))[0]!.revision, 0);
    // Candidates are the purchases an incoming credit could be returning.
    assert.equal(
      (await (await get(`/api/refund-candidates?id=${credit.id}`)).json())
        .candidates.length,
      1,
    );
    // Either member sees the same candidates for the household's credit.
    assert.equal(
      (
        await (
          await get(`/api/refund-candidates?id=${credit.id}`, 'katya')
        ).json()
      ).candidates.length,
      1,
    );
    const linkFields = {
      csrf,
      debitId: debit.id,
      creditId: credit.id,
      debitRevision: '0',
      creditRevision: '0',
      reason: 'Confirmed full refund',
    };
    assert.equal(
      (await post('/refund/link', { ...linkFields, csrf: '' })).status,
      403,
    );
    assert.equal(
      (
        await post(
          '/refund/link',
          {
            ...linkFields,
            debitId: '00000000-0000-4000-8000-000000000000',
            csrf: kateCsrf,
          },
          'katya',
        )
      ).status,
      400,
    );
    assert.equal((await post('/refund/link', linkFields)).status, 303);
    const linked = await repo.list();
    // The purchase keeps its own classification and carries the reduction; the
    // credit is left alone, explained by the link that already counted it.
    assert.equal(linked.find((r) => r.id === debit.id)!.kind, 'unresolved');
    assert.equal(linked.find((r) => r.id === debit.id)!.refund!.netMinor, '0');
    assert.equal(linked.find((r) => r.id === credit.id)!.kind, 'unresolved');
    assert.equal(
      linked.find((r) => r.id === credit.id)!.refund!.role,
      'refund',
    );
    const links = (
      await (await get(`/api/refund-candidates?id=${credit.id}`)).json()
    ).links;
    assert.equal(links.length, 1);
    assert.equal(
      (
        await post('/refund/unlink', {
          csrf,
          id: links[0].id,
          revision: '1',
          reason: 'Correct mistaken link',
        })
      ).status,
      303,
    );
    assert.ok((await repo.list()).every((r) => r.kind === 'unresolved'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
