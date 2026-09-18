import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase, migrate } from '../src/database.js';
import {
  CredentialReminders,
  credentialExpiryHealth,
  credentialHealthFromEnv,
  credentialsHealthFromEnv,
  initializeCredentialHealth,
  openAiCredentialHealth,
} from '../src/credential-health.js';
import { randomUUID } from 'node:crypto';
const expiry = '2026-12-10';
const date = (value: string) => new Date(value);

test('credential expiry metadata uses 5/2/1 Riga calendar days and never invents an expiry instant', () => {
  assert.equal(openAiCredentialHealth(undefined).state, 'unknown_expiry');
  assert.equal(openAiCredentialHealth('').state, 'unknown_expiry');
  for (const invalid of [
    '2026-02-30',
    '2026-02-30T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T00:00:00',
    '2026-10-01T00:00:00+99:00',
  ])
    assert.equal(openAiCredentialHealth(invalid).state, 'invalid_expiry');
  assert.equal(
    openAiCredentialHealth('2024-02-29T12:00:00+02:00', date('2024-02-01'))
      .expiresAt,
    '2024-02-29T10:00:00.000Z',
  );
  for (const [now, warning, state, days] of [
    ['2026-12-04T21:59:59Z', null, 'healthy', 6],
    ['2026-12-04T22:00:00Z', 5, 'expiring', 5],
    ['2026-12-07T22:00:00Z', 2, 'expiring', 2],
    ['2026-12-08T22:00:00Z', 1, 'expiring', 1],
    ['2026-12-09T22:00:00Z', 0, 'expires_today', 0],
    ['2026-12-10T21:59:59Z', 0, 'expires_today', 0],
    ['2026-12-10T22:00:00Z', 0, 'expired', -1],
  ] as const) {
    const health = openAiCredentialHealth(expiry, date(now));
    assert.equal(health.warningDays, warning);
    assert.equal(health.state, state);
    assert.equal(health.daysRemaining, days);
    assert.equal(health.expiresAt, null);
    assert.equal(health.expiresOn, expiry);
  }
  assert.equal(
    credentialHealthFromEnv(
      {
        OPENAI_API_KEY_EXPIRES_ON: expiry,
        OPENAI_API_KEY_EXPIRES_AT: 'invalid',
      },
      date('2026-12-05'),
    ).expiresOn,
    expiry,
  );
  assert.equal(
    openAiCredentialHealth('2026-12-10T12:00:00Z', date('2026-12-10T12:00:00Z'))
      .state,
    'expired',
  );
  assert.throws(() => openAiCredentialHealth(expiry, new Date('bad')));
});

test('credential warnings count calendar dates across both Riga DST transitions', () => {
  assert.equal(
    openAiCredentialHealth('2026-03-30', date('2026-03-28T22:00:00Z'))
      .daysRemaining,
    1,
  );
  assert.equal(
    openAiCredentialHealth('2026-03-30', date('2026-03-29T20:59:59Z'))
      .warningDays,
    1,
  );
  assert.equal(
    openAiCredentialHealth('2026-03-30', date('2026-03-29T21:00:00Z')).state,
    'expires_today',
  );
  assert.equal(
    openAiCredentialHealth('2026-10-26', date('2026-10-24T21:00:00Z'))
      .daysRemaining,
    1,
  );
  assert.equal(
    openAiCredentialHealth('2026-10-26', date('2026-10-25T21:59:59Z'))
      .warningDays,
    1,
  );
  assert.equal(
    openAiCredentialHealth('2026-10-26', date('2026-10-25T22:00:00Z')).state,
    'expires_today',
  );
});

test('credential reminders deduplicate configured date thresholds, retire stale notices and never retry uncertain sends', async () => {
  const db = memoryDatabase();
  const sent: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
      return { messageId: sent.length };
    },
    react: async () => {
      throw new Error('unexpected_react');
    },
    reply: async () => {
      throw new Error('unexpected_reply');
    },
  };
  try {
    await initializeCredentialHealth(db);
    await initializeCredentialHealth(db);
    const reminders = new CredentialReminders(db, '-123', transport);
    await reminders.enqueue(expiry, date('2026-12-05'));
    await reminders.enqueue(expiry, date('2026-12-06'));
    assert.deepEqual(
      await Promise.all([reminders.dispatchOne(), reminders.dispatchOne()]),
      ['sent', 'idle'],
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /within 5 calendar day/);
    assert.match(sent[0]!, /exact validity time unknown/);
    await reminders.enqueue(expiry, date('2026-12-08'));
    await reminders.enqueue(expiry, date('2026-12-09'));
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.match(sent[1]!, /within 1 calendar day/);
    assert.equal(
      (await reminders.status()).find((s) => s.state === 'cancelled')!.count,
      1,
    );
    await reminders.enqueue(expiry, date('2026-12-10'));
    assert.equal(await reminders.dispatchOne(), 'idle');
    await reminders.enqueue(expiry, date('2026-12-11'));
    assert.equal(await reminders.dispatchOne(), 'idle');
    // A replacement date starts an independent warning series; no secret/key hash.
    await reminders.enqueue('2027-01-10', date('2027-01-08'));
    const uncertain = new CredentialReminders(db, '-123', {
      send: async () => {
        throw new Error('timeout');
      },
      react: async () => {
        throw new Error('unexpected_react');
      },
      reply: async () => {
        throw new Error('unexpected_reply');
      },
    });
    assert.equal(await uncertain.dispatchOne(), 'uncertain');
    await reminders.enqueue('2027-01-10', date('2027-01-08T18:00:00Z'));
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(
      (await reminders.status()).find((s) => s.state === 'uncertain')!.count,
      1,
    );
    await reminders.enqueue('2027-02-10', date('2027-02-09'));
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(sent.length, 3);
    await reminders.enqueue('2027-03-10', date('2027-03-09'));
    await reminders.enqueue(undefined);
    assert.equal(await reminders.dispatchOne(), 'idle');
    // A process crash after claiming a message leaves an uncertain delivery,
    // rather than turning it back into a duplicate send after restart.
    await reminders.enqueue('2027-04-10', date('2027-04-09'));
    await db.query(
      "UPDATE credential_reminders SET state='sending',lease_until=now()-interval '1 second' WHERE state='queued'",
    );
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(
      (await reminders.status()).find((s) => s.state === 'uncertain')!.count,
      2,
    );
    const other = new CredentialReminders(db, '-456', transport);
    assert.deepEqual(await other.status(), []);
  } finally {
    await db.close();
  }
});

const ibkrExpiry = '2027-08-19T18:14:23Z';
const ibkr = (raw: string | undefined, now?: Date) =>
  credentialExpiryHealth('ibkr_flex_token', raw, now);

test('the IBKR Flex token is watched on the same 5/2/1 Riga ladder as the key', () => {
  assert.equal(ibkr(undefined).state, 'unknown_expiry');
  assert.equal(ibkr('').state, 'unknown_expiry');
  for (const invalid of ['2027-02-30T00:00:00Z', 'soon', '2027-08-19T18:14:23'])
    assert.equal(ibkr(invalid).state, 'invalid_expiry');
  // A bare date is accepted too, for a token whose exact instant was never
  // written down; it claims no validity time it was not given.
  assert.equal(ibkr('2027-08-19', date('2027-08-14')).expiresOn, '2027-08-19');
  assert.equal(ibkr('2027-08-19', date('2027-08-14')).expiresAt, null);
  for (const [now, warning, state, days] of [
    ['2027-08-13T12:00:00Z', null, 'healthy', 6],
    ['2027-08-14T12:00:00Z', 5, 'expiring', 5],
    ['2027-08-17T12:00:00Z', 2, 'expiring', 2],
    ['2027-08-18T12:00:00Z', 1, 'expiring', 1],
    ['2027-08-19T12:00:00Z', 0, 'expires_today', 0],
    ['2027-08-19T18:14:22Z', 0, 'expires_today', 0],
    ['2027-08-19T18:14:23Z', 0, 'expired', 0],
    ['2027-08-20T12:00:00Z', 0, 'expired', -1],
  ] as const) {
    const health = ibkr(ibkrExpiry, date(now));
    assert.equal(health.credential, 'ibkr_flex_token');
    assert.equal(health.label, 'IBKR Flex token');
    assert.equal(health.warningDays, warning);
    assert.equal(health.state, state);
    assert.equal(health.daysRemaining, days);
    assert.equal(health.expiresAt, '2027-08-19T18:14:23.000Z');
    assert.equal(health.expiresOn, null);
  }
});

test('every tracked credential is reported together, each from its own settings', () => {
  const health = credentialsHealthFromEnv(
    {
      OPENAI_API_KEY_EXPIRES_ON: expiry,
      IBKR_FLEX_TOKEN_EXPIRES_AT: ibkrExpiry,
      IBKR_FLEX_TOKEN_EXPIRES_ON: '2027-01-01',
    },
    date('2026-12-05'),
  );
  assert.deepEqual(
    health.map((c) => [c.credential, c.label, c.state]),
    [
      ['openai_api_key', 'OpenAI API key', 'expiring'],
      ['ibkr_flex_token', 'IBKR Flex token', 'healthy'],
    ],
  );
  // The token states the second it dies, so its instant wins over a date; the
  // key has only a date, so the date wins over an instant nobody confirmed.
  assert.equal(health[1]!.expiresAt, '2027-08-19T18:14:23.000Z');
  assert.equal(health[1]!.expiresOn, null);
  assert.equal(
    credentialHealthFromEnv(
      { OPENAI_API_KEY_EXPIRES_ON: expiry },
      date('2026-12-05'),
    ).expiresOn,
    expiry,
  );
  // Nothing configured is still reported: a credential nobody has told this
  // application about must not read as a healthy one.
  assert.deepEqual(
    credentialsHealthFromEnv({}, date('2026-12-05')).map((c) => c.state),
    ['unknown_expiry', 'unknown_expiry'],
  );
});

test('a reminder names the credential it is about and how to replace it', async () => {
  const db = memoryDatabase();
  const sent: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
      return { messageId: sent.length };
    },
    react: async () => {
      throw new Error('unexpected_react');
    },
    reply: async () => {
      throw new Error('unexpected_reply');
    },
  };
  try {
    await initializeCredentialHealth(db);
    const reminders = new CredentialReminders(db, '-123', transport);
    const health = await reminders.enqueueConfigured(
      {
        OPENAI_API_KEY_EXPIRES_ON: expiry,
        IBKR_FLEX_TOKEN_EXPIRES_AT: ibkrExpiry,
      },
      date('2026-12-05'),
    );
    assert.deepEqual(
      health.map((c) => [c.credential, c.state]),
      [
        ['openai_api_key', 'expiring'],
        ['ibkr_flex_token', 'healthy'],
      ],
    );
    // The token's own five-day notice, queued while the key's is still unsent:
    // neither credential's series retires the other's.
    await reminders.enqueue(ibkrExpiry, date('2027-08-14'), 'ibkr_flex_token');
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(sent.length, 2);
    assert.equal(
      sent.filter((t) => t.startsWith('The OpenAI API key')).length,
      1,
    );
    const token = sent.find((t) => t.startsWith('The IBKR Flex token'))!;
    assert.match(
      token,
      /reaches its configured expiry within 5 calendar day\(s\)/,
    );
    assert.match(token, /2027-08-19T18:14:23\.000Z/);
    assert.match(token, /Flex Web Service Configuration/);
    assert.match(token, /ibkr-flex-token/);
    assert.match(token, /IBKR_FLEX_TOKEN_EXPIRES_AT/);
    assert.deepEqual(
      (await reminders.status()).filter((s) => s.state === 'cancelled'),
      [],
    );
    // A replaced token starts an independent series and retires the unsent
    // notices of the old one, leaving the key's records alone.
    await reminders.enqueue(ibkrExpiry, date('2027-08-17'), 'ibkr_flex_token');
    await reminders.enqueue(
      '2028-08-19T18:14:23Z',
      date('2027-08-17'),
      'ibkr_flex_token',
    );
    const cancelled = await db.query(
      "SELECT credential FROM credential_reminders WHERE state='cancelled'",
    );
    assert.deepEqual(
      cancelled.rows.map((r) => String(r.credential)),
      ['ibkr_flex_token'],
    );
  } finally {
    await db.close();
  }
});

test('the migrated schema accepts an IBKR Flex token reminder and nothing invented', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,chat_id,message,state)
       VALUES($1,'ibkr_flex_token','at:2027-08-19T18:14:23.000Z',5,'-123','reminder','queued')`,
      [randomUUID()],
    );
    const { rows } = await db.query(
      "SELECT credential FROM credential_reminders WHERE credential='ibkr_flex_token'",
    );
    assert.equal(rows.length, 1);
    await assert.rejects(
      db.query(
        `INSERT INTO credential_reminders(id,credential,expiry_key,warning_days,chat_id,message,state)
         VALUES($1,'coffee_machine','at:2027-08-19T18:14:23.000Z',5,'-123','reminder','queued')`,
        [randomUUID()],
      ),
    );
  } finally {
    await db.close();
  }
});
