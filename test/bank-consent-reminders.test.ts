import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import {
  CredentialReminders,
  bankConsentNotice,
  bankConsentsHealth,
  initializeCredentialHealth,
} from '../src/credential-health.js';
import type { TelegramTransport } from '../src/telegram.js';

const CHAT = '-1001234567890';

function transport(): TelegramTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(chatId: string, text: string) {
      assert.equal(chatId, CHAT);
      sent.push(text);
      return { messageId: sent.length };
    },
  } as TelegramTransport & { sent: string[] };
}

async function household(consents: [string, string, string][]) {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeCredentialHealth);
  for (const [owner, bank, expiresAt] of consents)
    await db.query(
      `INSERT INTO bank_consents(owner,bank,country,state_hash,state_expires_at,expires_at,status)
       VALUES($1,$2,'LV',$3,now()+interval '15 minutes',$4,'authorized')`,
      [owner, bank, `hash-${owner}-${bank}`, expiresAt],
    );
  return db;
}

const NOW = new Date('2026-09-16T12:00:00Z');

test('the ladder runs from five days out to the day it lapses', () => {
  const at = (expiresAt: string) =>
    bankConsentNotice(
      { owner: 'rodion', bank: 'Swedbank', country: 'LV', expiresAt },
      NOW,
    ).warningDays;
  assert.equal(at('2026-09-30T09:00:00Z'), null);
  assert.equal(at('2026-09-21T09:00:00Z'), 5);
  assert.equal(at('2026-09-18T09:00:00Z'), 2);
  assert.equal(at('2026-09-17T09:00:00Z'), 1);
  // 23:00 in Riga on the same calendar day, which is the day it lapses.
  assert.equal(at('2026-09-16T20:00:00Z'), 0);
  assert.equal(at('2026-09-10T09:00:00Z'), 0);
  assert.equal(
    bankConsentNotice(
      {
        owner: 'rodion',
        bank: 'Swedbank',
        country: 'LV',
        expiresAt: '2026-09-10T09:00:00Z',
      },
      NOW,
    ).expired,
    true,
  );
});

test("App health lists both members' approvals, soonest first", async () => {
  const db = await household([
    ['rodion', 'Wise', '2026-12-01T09:00:00Z'],
    ['katya', 'Revolut', '2026-09-18T09:00:00Z'],
    ['katya', 'Swedbank', '2026-09-10T09:00:00Z'],
  ]);
  try {
    const health = await bankConsentsHealth(db, NOW);
    // Whoever it belongs to, and the nearest deadline at the top: the page
    // exists to answer "what runs out next", not "what is mine".
    assert.deepEqual(
      health.map((c) => [c.owner, c.bank, c.daysRemaining, c.expired]),
      [
        ['katya', 'Swedbank', -6, true],
        ['katya', 'Revolut', 2, false],
        ['rodion', 'Wise', 76, false],
      ],
    );
    // Expiry metadata only. No session, no state hash, no credential.
    assert.deepEqual(Object.keys(health[0]!).sort(), [
      'bank',
      'country',
      'daysRemaining',
      'expired',
      'expiresAt',
      'owner',
      'warningDays',
    ]);
  } finally {
    await db.close();
  }
});

test('an approval nearing its end is queued once and sent to Telegram', async () => {
  const db = await household([
    ['rodion', 'Swedbank', '2026-09-18T09:00:00Z'],
    ['rodion', 'Wise', '2026-12-01T09:00:00Z'],
  ]);
  const wire = transport();
  const reminders = new CredentialReminders(db, CHAT, wire);
  try {
    const notices = await reminders.enqueueBankConsents(NOW);
    assert.deepEqual(
      notices.map((n) => [n.bank, n.warningDays]),
      [
        ['Swedbank', 2],
        ['Wise', null],
      ],
    );
    // Running the loop again queues nothing further.
    await reminders.enqueueBankConsents(NOW);
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(wire.sent.length, 1);
    assert.match(wire.sent[0]!, /Swedbank \(LV\), rodion/);
    assert.match(wire.sent[0]!, /expires in 2 day\(s\)/);
    assert.match(wire.sent[0]!, /Bank connections/);
    assert.doesNotMatch(wire.sent[0]!, /Wise/);
  } finally {
    await db.close();
  }
});

test('an approval that already lapsed is reported as stopping the imports', async () => {
  const db = await household([['katya', 'Wise', '2026-09-12T09:00:00Z']]);
  const wire = transport();
  const reminders = new CredentialReminders(db, CHAT, wire);
  try {
    const [notice] = await reminders.enqueueBankConsents(NOW);
    assert.equal(notice!.expired, true);
    assert.equal(notice!.warningDays, 0);
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.match(wire.sent[0]!, /expired on 2026-09-12/);
    assert.match(wire.sent[0]!, /Nothing is importing/);
  } finally {
    await db.close();
  }
});

test('renewing an approval retires the notice that has not been sent', async () => {
  const db = await household([['rodion', 'Swedbank', '2026-09-18T09:00:00Z']]);
  const wire = transport();
  const reminders = new CredentialReminders(db, CHAT, wire);
  try {
    await reminders.enqueueBankConsents(NOW);
    await db.query(
      "UPDATE bank_consents SET expires_at='2026-11-01T09:00:00Z' WHERE bank='Swedbank'",
    );
    await reminders.enqueueBankConsents(NOW);
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(wire.sent.length, 0);
    const queued = await db.query(
      "SELECT state FROM credential_reminders WHERE credential='bank_consent'",
    );
    assert.deepEqual(
      queued.rows.map((r) => String(r.state)),
      ['cancelled'],
    );
  } finally {
    await db.close();
  }
});

test('each bank keeps its own notice; one does not cancel another', async () => {
  const db = await household([
    ['rodion', 'Swedbank', '2026-09-17T09:00:00Z'],
    ['rodion', 'Revolut', '2026-09-18T09:00:00Z'],
  ]);
  const wire = transport();
  const reminders = new CredentialReminders(db, CHAT, wire);
  try {
    await reminders.enqueueBankConsents(NOW);
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'sent');
    assert.equal(await reminders.dispatchOne(), 'idle');
    assert.equal(wire.sent.length, 2);
    assert.ok(wire.sent.some((t) => t.includes('Swedbank')));
    assert.ok(wire.sent.some((t) => t.includes('Revolut')));
  } finally {
    await db.close();
  }
});
