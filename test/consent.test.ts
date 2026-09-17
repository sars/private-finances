import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryDatabase } from '../src/database.js';
import { ConsentService, type ConsentPost } from '../src/consent.js';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

test('consent binds owner and bank, stores only hashed state, claims once, saves private session', async () => {
  const db = memoryDatabase(),
    dir = await mkdtemp(join(tmpdir(), 'consent-'));
  let state = '',
    expiry = '',
    calls = 0;
  const sessionId = randomUUID();
  const post: ConsentPost = async (path, body, headers) => {
    assert.match(headers.Authorization!, /^Bearer /);
    assert.equal(
      (
        JSON.parse(
          Buffer.from(
            headers.Authorization!.slice(7).split('.')[0]!,
            'base64url',
          ).toString(),
        ) as { kid: string }
      ).kid,
      'synthetic',
    );
    if (path === '/auth') {
      state = String(body.state);
      expiry = (body.access as { valid_until: string }).valid_until;
      assert.deepEqual(body.aspsp, { name: 'Wise', country: 'BE' });
      return {
        url: 'https://tilisy.enablebanking.com/ais/start?sessionid=synthetic',
      };
    }
    calls++;
    assert.deepEqual(body, { code: 'synthetic-code' });
    return {
      session_id: sessionId,
      aspsp: { name: 'Wise', country: 'BE' },
      psu_type: 'personal',
      access: { valid_until: expiry },
    };
  };
  const service = new ConsentService({
    db,
    privateKey,
    applicationId: 'synthetic',
    redirectUrl: 'https://example.com/callback',
    secretDirectory: dir,
    post,
  });
  try {
    await service.initialize();
    await service.initialize();
    await service.start('rodion', 'Wise', 'BE');
    const stored = JSON.stringify(
      (await db.query('SELECT * FROM bank_consents')).rows,
    );
    assert.ok(!stored.includes(state));
    await assert.rejects(service.finish('katya', state, 'synthetic-code'));
    assert.equal(calls, 0);
    const completed = await Promise.allSettled([
      service.finish('rodion', state, 'synthetic-code'),
      service.finish('rodion', state, 'synthetic-code'),
    ]);
    assert.equal(completed.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(calls, 1);
    const file = join(dir, 'enablebanking-rodion-wise-session');
    assert.equal((await readFile(file, 'utf8')).trim(), sessionId);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await service.list('rodion'))[0]!.status, 'authorized');
    assert.deepEqual(await service.list('katya'), []);
    assert.ok(
      !JSON.stringify(await service.list('rodion')).includes(sessionId),
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired and uncertain callbacks cannot be exchanged again; failed storage is safe', async () => {
  const db = memoryDatabase(),
    dir = await mkdtemp(join(tmpdir(), 'consent-'));
  let state = '',
    expiry = '',
    calls = 0,
    fail = true;
  const post: ConsentPost = async (path, body) => {
    if (path === '/auth') {
      state = String(body.state);
      expiry = (body.access as { valid_until: string }).valid_until;
      return {
        url: 'https://auth.enablebanking.com/ais/start?sessionid=synthetic',
      };
    }
    calls++;
    if (fail) throw new Error('sensitive provider body');
    return {
      session_id: randomUUID(),
      aspsp: { name: 'Revolut', country: 'LT' },
      psu_type: 'personal',
      access: { valid_until: expiry },
    };
  };
  const service = new ConsentService({
    db,
    privateKey,
    applicationId: 'synthetic',
    redirectUrl: 'https://example.com/callback',
    credentialsByOwner: {
      katya: { applicationId: 'synthetic-katya', privateKey },
    },
    secretDirectory: join(dir, 'missing'),
    post,
  });
  try {
    await service.initialize();
    await service.start('katya', 'Revolut', 'LT');
    await db.query(
      "UPDATE bank_consents SET state_expires_at=now()-interval '1 second'",
    );
    await assert.rejects(service.finish('katya', state, 'code'));
    assert.equal(calls, 0);
    await service.start('katya', 'Revolut', 'LT');
    await assert.rejects(service.finish('katya', state, 'code'), {
      message:
        'Bank connection could not be completed. Start a new connection.',
    });
    await assert.rejects(service.finish('katya', state, 'code'));
    assert.equal(calls, 1);
    assert.equal((await service.list('katya'))[0]!.status, 'failed');
    fail = false;
    await service.start('katya', 'Revolut', 'LT');
    await assert.rejects(service.finish('katya', state, 'code'));
    assert.equal((await service.list('katya'))[0]!.status, 'failed');
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('authorization rejects an untrusted redirect host', async () => {
  const db = memoryDatabase();
  const service = new ConsentService({
    db,
    privateKey,
    applicationId: 'synthetic',
    redirectUrl: 'https://example.com/callback',
    secretDirectory: tmpdir(),
    post: async () => ({
      url: 'https://auth.enablebanking.com.evil.example/ais/start',
    }),
  });
  try {
    await service.initialize();
    await assert.rejects(service.start('rodion', 'Wise', 'BE'));
    assert.equal((await service.list('rodion'))[0]!.status, 'failed');
  } finally {
    await db.close();
  }
});

test('owner credentials sign both consent endpoints and wrong-owner state cannot exchange', async () => {
  const db = memoryDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'consent-owners-'));
  const requests: Array<{ path: string; kid: string }> = [];
  let state = '',
    expiry = '';
  const service = new ConsentService({
    db,
    applicationId: 'legacy-must-not-win',
    privateKey,
    credentialsByOwner: {
      rodion: { applicationId: 'synthetic-rodion', privateKey },
      katya: { applicationId: 'synthetic-katya', privateKey },
    },
    redirectUrl: 'https://example.com/callback',
    secretDirectory: dir,
    post: async (path, body, headers) => {
      const header = JSON.parse(
        Buffer.from(
          headers.Authorization!.slice(7).split('.')[0]!,
          'base64url',
        ).toString(),
      ) as { kid: string };
      requests.push({ path, kid: header.kid });
      if (path === '/auth') {
        state = String(body.state);
        expiry = (body.access as { valid_until: string }).valid_until;
        return {
          url: 'https://auth.enablebanking.com/ais/start?sessionid=synthetic',
        };
      }
      return {
        session_id: randomUUID(),
        aspsp: { name: 'Wise', country: 'LV' },
        psu_type: 'personal',
        access: { valid_until: expiry },
      };
    },
  });
  try {
    await service.initialize();
    for (const owner of ['rodion', 'katya'] as const) {
      await service.start(owner, 'Wise', 'LV');
      const before = requests.length;
      await assert.rejects(
        service.finish(owner === 'rodion' ? 'katya' : 'rodion', state, 'code'),
      );
      assert.equal(requests.length, before);
      assert.equal((await service.list(owner))[0]!.status, 'pending');
      await service.finish(owner, state, 'code');
    }
    assert.deepEqual(requests, [
      { path: '/auth', kid: 'synthetic-rodion' },
      { path: '/sessions', kid: 'synthetic-rodion' },
      { path: '/auth', kid: 'synthetic-katya' },
      { path: '/sessions', kid: 'synthetic-katya' },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing owner credentials fail before network without using Rodion fallback', async () => {
  const db = memoryDatabase();
  let calls = 0,
    state = '';
  const config = {
    db,
    applicationId: 'synthetic-legacy-rodion',
    privateKey,
    redirectUrl: 'https://example.com/callback',
    secretDirectory: tmpdir(),
    post: (async (_path, body) => {
      calls++;
      state = String(body.state);
      return {
        url: 'https://auth.enablebanking.com/ais/start?sessionid=synthetic',
      };
    }) satisfies ConsentPost,
  };
  const service = new ConsentService(config);
  try {
    await service.initialize();
    await assert.rejects(service.start('katya', 'Wise', 'LV'));
    assert.equal(calls, 0);
    assert.deepEqual(await service.list('katya'), []);
    // A restart with missing credentials must also refuse an existing callback.
    const configured = new ConsentService({
      ...config,
      credentialsByOwner: {
        katya: { applicationId: 'synthetic-katya', privateKey },
      },
    });
    await configured.start('katya', 'Wise', 'LV');
    assert.equal(calls, 1);
    await assert.rejects(service.finish('katya', state, 'code'));
    assert.equal(calls, 1);
    assert.equal((await service.list('katya'))[0]!.status, 'failed');
    await assert.rejects(
      new ConsentService({ ...config, applicationId: undefined }).start(
        'rodion',
        'Wise',
        'LV',
      ),
    );
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test('starting another approval leaves a live one authorised until the new one succeeds', async () => {
  const db = memoryDatabase(),
    dir = await mkdtemp(join(tmpdir(), 'consent-live-'));
  let state = '';
  let accept = true;
  let sessionExpiry = '';
  const post: ConsentPost = async (path, body) => {
    if (path === '/auth') {
      if (!accept) throw new Error('provider says no');
      state = String(body.state);
      sessionExpiry = (body.access as { valid_until: string }).valid_until;
      return {
        url: 'https://tilisy.enablebanking.com/ais/start?sessionid=synthetic',
      };
    }
    if (!accept) throw new Error('provider says no');
    return {
      session_id: randomUUID(),
      aspsp: { name: 'Wise', country: 'LV' },
      psu_type: 'personal',
      access: { valid_until: sessionExpiry },
    };
  };
  const service = new ConsentService({
    db,
    privateKey,
    applicationId: 'synthetic',
    redirectUrl: 'https://example.com/callback',
    secretDirectory: dir,
    post,
  });
  const live = async () => (await service.list('rodion'))[0]!;
  try {
    await service.initialize();
    // A first approval, completed.
    await service.start('rodion', 'Wise', 'LV');
    await service.finish('rodion', state, 'code-1');
    const first = await live();
    assert.equal(first.status, 'authorized');

    // A second attempt is started and abandoned: the live one is untouched.
    await service.start('rodion', 'Wise', 'LV');
    assert.deepEqual(await live(), first);

    // A second attempt the provider refuses: still untouched.
    accept = false;
    await assert.rejects(service.start('rodion', 'Wise', 'LV'));
    assert.deepEqual(await live(), first);

    // A renewal whose callback fails at the provider: back to the live one.
    accept = true;
    await service.start('rodion', 'Wise', 'LV');
    accept = false;
    await assert.rejects(service.finish('rodion', state, 'code-2'));
    assert.deepEqual(await live(), first);

    // A renewal that succeeds replaces it, with the new expiry.
    accept = true;
    await service.start('rodion', 'Wise', 'LV');
    await service.finish('rodion', state, 'code-3');
    const renewed = await live();
    assert.equal(renewed.status, 'authorized');
    assert.equal(renewed.expiry, new Date(sessionExpiry).toISOString());
    assert.ok(Date.parse(renewed.expiry) > Date.parse(first.expiry));

    // A bank with no live approval still reads "failed" when refused.
    accept = false;
    await assert.rejects(service.start('rodion', 'Revolut', 'LV'));
    const revolut = (await service.list('rodion')).find(
      (c) => c.bank === 'Revolut',
    );
    assert.equal(revolut?.status, 'failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await db.close?.();
  }
});
