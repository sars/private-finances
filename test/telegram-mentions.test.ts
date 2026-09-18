import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
import { synthetic } from '../src/synthetic.js';
import {
  addressMentions,
  initializeTelegram,
  namedMentions,
  TelegramClarifications,
  telegramTransport,
  type TelegramMention,
} from '../src/telegram.js';

const settings = { chatId: '-123', userIds: { rodion: '101', katya: '102' } };
const token = '123456:synthetic_fake_token_123456789';

test('a name the bot writes is the address; a name the bank wrote is not', () => {
  // The bank's own description names a payee. Tagging that would notify
  // someone about a payment that is not theirs, so only the leading address —
  // the name the bot itself put there — becomes a mention.
  const prompt =
    'Rodion, what was this payment for?\nBank description: TRANSFER-4 Sent money to Rodion Salnik';
  assert.deepEqual(addressMentions(prompt, ['rodion'], settings.userIds), [
    { offset: 0, length: 6, userId: '101' },
  ]);
  // The web form opens the question with the stored key rather than the
  // display name; it addresses the same person.
  assert.deepEqual(
    addressMentions(
      'rodion: Groceries. What was this?',
      ['rodion'],
      settings.userIds,
    ),
    [{ offset: 0, length: 6, userId: '101' }],
  );
  // Two addressees are found in the order given, never the same range twice.
  assert.deepEqual(
    addressMentions(
      'rodion (answered by katya): Saved as personal expense',
      ['rodion', 'katya'],
      settings.userIds,
    ),
    [
      { offset: 0, length: 6, userId: '101' },
      { offset: 20, length: 5, userId: '102' },
    ],
  );
  // A message that names nobody, and a member with no configured id, tag nothing.
  assert.deepEqual(addressMentions('Saved.', ['katya'], settings.userIds), []);
  assert.deepEqual(
    addressMentions('Katya, was this yours?', ['katya'], {
      rodion: '101',
    } as unknown as Record<'rodion' | 'katya', string>),
    [],
  );
});

test("a note in the bot's own words tags whoever it names, in that order", () => {
  assert.deepEqual(
    namedMentions(
      'This refund question is addressed to Katya, and only they can answer it.',
      settings.userIds,
    ),
    [{ offset: 37, length: 5, userId: '102' }],
  );
  const both = namedMentions('Katya answered for Rodion.', settings.userIds);
  assert.deepEqual(
    both.map((mention) => mention.userId),
    ['102', '101'],
  );
  assert.deepEqual(namedMentions('Nothing was saved.', settings.userIds), []);
});

test('mentions travel as text_mention entities, and an impossible range is dropped', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = telegramTransport(token, async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 7, chat: { id: -123 } },
      }),
    );
  });
  await transport.send('-123', 'Rodion, what was this?', {
    mentions: [{ offset: 0, length: 6, userId: '101' }],
  });
  assert.deepEqual(bodies[0]?.entities, [
    {
      type: 'text_mention',
      offset: 0,
      length: 6,
      user: { id: 101, is_bot: false, first_name: 'Rodion' },
    },
  ]);
  // The message stays plain text: no parse mode, so a bank description full of
  // markup characters is never interpreted.
  assert.equal('parse_mode' in bodies[0]!, false);
  await transport.reply('-123', 7, 'rodion: Saved.', {
    mentions: [{ offset: 0, length: 6, userId: '101' }],
  });
  assert.deepEqual(bodies[1]?.entities, [
    {
      type: 'text_mention',
      offset: 0,
      length: 6,
      user: { id: 101, is_bot: false, first_name: 'rodion' },
    },
  ]);
  // Telegram rejects the whole message over an entity that runs past its end,
  // or a user id that is not one. Saying nothing is worse than saying it
  // untagged, so the impossible range goes and the message stays.
  await transport.send('-123', 'Short', {
    mentions: [
      { offset: 3, length: 40, userId: '101' },
      { offset: -1, length: 2, userId: '101' },
      { offset: 0, length: 5, userId: 'not-an-id' },
    ] as TelegramMention[],
  });
  assert.equal('entities' in bodies[2]!, false);
  assert.equal(bodies[2]?.text, 'Short');
  await transport.send('-123', 'Plain', {});
  assert.equal('entities' in bodies[3]!, false);
});

test('a queued question is sent tagging the member whose payment it is', async () => {
  const db = memoryDatabase();
  const sent: Array<{ text: string; mentions?: TelegramMention[] }> = [];
  try {
    await migrate(db);
    await db.transaction(initializeTelegram);
    const repo = new Repository(db);
    await repo.importBatch(synthetic);
    const transaction = (await repo.list('rodion'))[0]!;
    const bot = new TelegramClarifications(db, settings, {
      async send(_chat, text, options) {
        sent.push({ text, mentions: options?.mentions });
        return { messageId: 42 };
      },
      async react() {
        throw new Error('unexpected_react');
      },
      async reply() {
        throw new Error('unexpected_reply');
      },
    });
    await bot.queue(
      transaction.id,
      0,
      'Rodion, what was this payment for?',
      'rodion',
    );
    assert.equal(await bot.dispatchOne(), 'sent');
    assert.deepEqual(sent[0]?.mentions, [
      { offset: 0, length: 6, userId: '101' },
    ]);
  } finally {
    await db.close();
  }
});
