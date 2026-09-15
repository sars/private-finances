import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import {
  initializeReceipts,
  Receipts,
  parseReceipt,
  receiptDownloader,
  merchantTokens,
  merchantMatches,
  type PdfPage,
} from '../src/receipts.js';
import { llmBudgetSummary } from '../src/llm-budget.js';
const settings = { chatId: '-10', userIds: { rodion: '10', katya: '20' } };
const update = (chat = -10, user = 10, id = 1) => ({
  message: {
    message_id: id,
    chat: { id: chat },
    from: { id: user },
    photo: [{ file_id: 'synthetic', file_size: 100 }],
  },
});
const extraction = {
  isReceipt: true,
  merchant: 'TEST MARKET',
  date: '2026-09-10',
  amountMinor: '1234',
  currency: 'EUR',
  items: ['Bread'],
};
const reply = (value: unknown = extraction) => ({
  status: 'completed',
  usage: {
    input_tokens: 1000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
  },
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(value) }],
    },
  ],
});
async function setup() {
  const db = memoryDatabase();
  await migrate(db);
  await db.transaction(initializeReceipts);
  return { db, receipts: new Receipts(db) };
}
// Distinct synthetic photos: identical bytes now mean "literally the same photo"
// and are deliberately rejected as a duplicate, so the shared fixture varies them.
let photoBytes = 0;
// No test may need poppler installed, so every rasterizer here is a fake. This
// one fails loudly if a photo path ever reaches it: a JPEG is never rendered.
const unusedRasterizer = async (): Promise<PdfPage[]> => {
  throw new Error('rasterizer_must_not_run_for_a_photo');
};
const options = {
  model: 'gpt-5.4-mini',
  maxRequestsPerDay: 50,
  download: async () => ({
    bytes: Buffer.from([255, 216, 255, photoBytes++ & 0xff]),
    mime: 'image/jpeg',
  }),
  request: async () => reply(),
  rasterize: unusedRasterizer,
};
// A synthetic PDF: only the magic bytes matter, because the fake rasterizer
// decides what pages come out of it.
let pdfBytes = 0;
const syntheticPdf = () =>
  Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.from([pdfBytes++ & 0xff]),
  ]);
const syntheticPage = (page: number): PdfPage => ({
  bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, page]),
  mime: 'image/png',
});
/** Downloads one PDF and renders it as `pages` synthetic page images. */
function pdfRun(pages: number, pdf: Buffer = syntheticPdf()) {
  const bodies: Record<string, unknown>[] = [];
  let rasterized = 0;
  const run = {
    ...options,
    download: async () => ({ bytes: pdf, mime: 'application/pdf' }),
    rasterize: async (received: Buffer, maxPages: number) => {
      rasterized++;
      assert.ok(received.equals(pdf));
      if (pages > maxPages) throw new Error('receipt_pdf_too_many_pages');
      return Array.from({ length: pages }, (_, index) =>
        syntheticPage(index + 1),
      );
    },
    request: async (body: Record<string, unknown>) => {
      bodies.push(body);
      return reply();
    },
  };
  return {
    run,
    pdf,
    bodies,
    rasterizedCount: () => rasterized,
    images: () => {
      const input = (bodies[0]?.input ?? []) as Array<Record<string, unknown>>;
      const content = (input[0]?.content ?? []) as Array<
        Record<string, unknown>
      >;
      return content.filter((part) => part.type === 'input_image');
    },
  };
}
const pdfDocumentUpdate = (mime = 'application/pdf', id = 1, user = 10) => ({
  message: {
    message_id: id,
    chat: { id: -10 },
    from: { id: user },
    document: { file_id: 'syntheticpdf', file_size: 2048, mime_type: mime },
  },
});
const sameImage = {
  ...options,
  download: async () => ({
    bytes: Buffer.from([255, 216, 255, 42]),
    mime: 'image/jpeg',
  }),
};
test('receipt intake is paired-owner-only and duplicate updates never create another job', async () => {
  const { db, receipts } = await setup();
  try {
    assert.equal(await receipts.receive(settings, update(1)), false);
    assert.equal(await receipts.receive(settings, update(-10, 30)), false);
    assert.equal(await receipts.receive(settings, update()), true);
    await receipts.receive(settings, update());
    assert.equal((await receipts.list('rodion')).length, 1);
    assert.equal((await receipts.list('katya')).length, 1);
  } finally {
    await db.close();
  }
});
test('receipt extraction shares measured budget and preserves ambiguous evidence without categorizing', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const rows = await receipts.list('rodion');
    assert.equal(rows[0]?.state, 'pending');
    assert.deepEqual(rows[0]?.extraction, extraction);
    assert.equal(
      (await db.query('SELECT state FROM llm_cost_ledger')).rows[0]?.state,
      'measured',
    );
    assert.equal(await receipts.processOne(options), false);
    assert.ok(await llmBudgetSummary(db));
  } finally {
    await db.close();
  }
});
test('budget pause queues receipt without calling model; uncertain request is never automatically repeated', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await db.query("UPDATE llm_budget_metadata SET pause_reason='test'");
    let calls = 0;
    const run = {
      ...options,
      request: async () => {
        calls++;
        throw new Error('network');
      },
    };
    assert.equal(await receipts.processOne(run), false);
    assert.equal(calls, 0);
    await db.query('UPDATE llm_budget_metadata SET pause_reason=NULL');
    await receipts.processOne(run);
    assert.equal(calls, 1);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'failed');
    assert.equal(
      (await db.query('SELECT state FROM llm_cost_ledger')).rows[0]?.state,
      'uncertain',
    );
    await receipts.processOne(run);
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});
test('match searches both family owners with exact amount/currency/day and unambiguous merchant', async () => {
  const { db, receipts } = await setup();
  try {
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET 01')",
    );
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000002','test','2','b','rodion','2026-09-10T12:00:00Z','EUR',-4321,'CORNER DELI 02')",
    );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'matched');
    assert.equal(
      (
        await db.query(
          "SELECT kind FROM transactions WHERE id='00000000-0000-4000-8000-000000000001'",
        )
      ).rows[0]?.kind,
      'unresolved',
    );
    // Katya photographs a different purchase; it may attach to Rodion's payment.
    await receipts.receive(settings, update(-10, 20, 2));
    await receipts.processOne({
      ...options,
      request: async () =>
        reply({ ...extraction, merchant: 'CORNER DELI', amountMinor: '4321' }),
    });
    const katyaReceipt = (await receipts.list('katya'))[0]!;
    assert.equal(katyaReceipt.state, 'matched');
    assert.equal(katyaReceipt.owner, 'katya');
    assert.equal(katyaReceipt.transaction_owner, 'rodion');
  } finally {
    await db.close();
  }
});
test('receipt validator rejects invented floats and impossible dates; downloader rejects path traversal', async () => {
  assert.throws(() => parseReceipt({ ...extraction, amountMinor: '12.34' }));
  assert.throws(() => parseReceipt({ ...extraction, date: '2026-02-31' }));
  const fetcher = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: { file_path: '../secrets.png', file_size: 10 },
      }),
    );
  await assert.rejects(
    receiptDownloader('123456:abcdefghijklmnopqrstuvwxyzABCDE', fetcher)('x'),
    /receipt_download_failed/,
  );
});
test('ambiguous same-price payments remain pending; manual attachment can cross family owners', async () => {
  const { db, receipts } = await setup();
  try {
    for (const [id, owner] of [
      ['1', 'rodion'],
      ['2', 'rodion'],
      ['3', 'katya'],
    ])
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES($1,'test',$2,'a',$3,'2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
        [`00000000-0000-4000-8000-00000000000${id}`, id, owner],
      );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('rodion'))[0]?.id);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
    assert.ok(await receipts.image('katya', id));
    assert.equal(
      await receipts.attach(
        'rodion',
        id,
        '00000000-0000-4000-8000-000000000003',
      ),
      true,
    );
    assert.equal(
      await receipts.attach(
        'rodion',
        id,
        '00000000-0000-4000-8000-000000000001',
      ),
      true,
    );
  } finally {
    await db.close();
  }
});
test('receipt and classifier contend for the same remaining monthly allowance', async () => {
  const { db, receipts } = await setup();
  try {
    const { Classifier } = await import('../src/classifier.js');
    const id = '00000000-0000-4000-8000-000000000001';
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES($1,'test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
      [id],
    );
    await db.query(
      "INSERT INTO llm_cost_ledger(proposal_id,month,model,state,held_nano,input_price_nano,cached_price_nano,output_price_nano) VALUES('00000000-0000-4000-8000-000000000002',to_char(now() AT TIME ZONE 'Europe/Riga','YYYY-MM'),'gpt-5.4-mini','uncertain',9000000000,750,75,4500)",
    );
    await receipts.receive(settings, update());
    let calls = 0;
    const request = async () => {
      calls++;
      return { ...reply(), usage: undefined };
    };
    const classifier = new Classifier(
      db,
      {
        apiKey: 'synthetic',
        model: options.model,
        maxRequestsPerDay: 50,
        maxInputChars: 4000,
        maxOutputTokens: 512,
        timeoutMs: 1000,
        categories: ['Food / Groceries'],
      },
      request,
    );
    await Promise.all([
      receipts.processOne({ ...options, request }),
      classifier.propose(id, 0, 'rodion'),
    ]);
    assert.equal(calls, 1);
    const sum = (
      await db.query(
        'SELECT sum(held_nano+spent_nano)::text AS used FROM llm_cost_ledger',
      )
    ).rows[0];
    assert.ok(BigInt(String(sum?.used)) <= 9500000000n);
  } finally {
    await db.close();
  }
});
test('late bank import is matched by bounded no-model pending sweep', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    let calls = 0;
    await receipts.processOne({
      ...options,
      request: async () => {
        calls++;
        return reply();
      },
    });
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
    );
    assert.equal(await receipts.retryPendingMatches(), 1);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'matched');
    assert.equal(calls, 1);
    assert.equal(await receipts.retryPendingMatches(), 0);
  } finally {
    await db.close();
  }
});
test('photo intake and cursor commit atomically; malformed file cannot poison cursor', async () => {
  const { db, receipts } = await setup();
  try {
    const { pollOnce, initializeTelegramCursor } =
      await import('../src/telegram-cli.js');
    await db.transaction(initializeTelegramCursor);
    const photo = { update_id: 1, ...update() };
    const failing = {
      ...db,
      transaction: <T>(
        action: (tx: import('../src/database.js').Executor) => Promise<T>,
      ) =>
        db.transaction((tx) =>
          action({
            query: (sql, params) => {
              if (sql.startsWith('UPDATE telegram_poll_cursor'))
                throw new Error('cursor failure');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    const receive = (
      scoped: import('../src/database.js').Database,
      raw: unknown,
    ) => new Receipts(scoped).receive(settings, raw);
    await assert.rejects(
      pollOnce(failing, settings, async () => [photo], receive),
      /cursor failure/,
    );
    assert.equal((await receipts.list('rodion')).length, 0);
    assert.equal(await pollOnce(db, settings, async () => [photo], receive), 2);
    const malformed = { update_id: 2, ...update(-10, 10, 2) };
    malformed.message.photo[0]!.file_id = 'bad\0id';
    assert.equal(
      await pollOnce(db, settings, async () => [malformed], receive),
      3,
    );
    assert.equal((await receipts.list('rodion')).length, 1);
  } finally {
    await db.close();
  }
});
test('source correction or a new duplicate between match read and attachment leaves receipt pending', async () => {
  for (const correction of ['ledger', 'original', 'collision']) {
    const { db, receipts } = await setup();
    try {
      await receipts.receive(settings, update());
      await receipts.processOne(options);
      const id = String((await receipts.list('rodion'))[0]?.id);
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
      );
      let changed = false;
      const racing: import('../src/database.js').Database = {
        ...db,
        query: async <T extends import('../src/database.js').Row>(
          sql: string,
          params?: unknown[],
        ) => {
          const result = await db.query<T>(sql, params);
          if (
            sql.startsWith(
              'SELECT id,description,revision,owner,source,currency,amount_minor,source_details,status FROM transactions',
            ) &&
            !changed
          ) {
            changed = true;
            if (correction === 'ledger')
              await db.query(
                "UPDATE transactions SET amount_minor=-9999,revision=revision+1 WHERE source='test'",
              );
            else if (correction === 'original')
              await db.query(
                "UPDATE transactions SET currency='UAH',source='monobank',source_details='{\"operationAmount\":-9999,\"currencyCode\":978}'::jsonb,revision=revision+1 WHERE source='test'",
              );
            else
              await db.query(
                "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000002','test','2','a','katya','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
              );
          }
          return result;
        },
      };
      await new Receipts(racing).match(id, 'rodion');
      assert.equal(changed, true);
      assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
      assert.equal(
        (await db.query('SELECT * FROM receipt_attachment_events')).rows.length,
        0,
      );
    } finally {
      await db.close();
    }
  }
});

test('receipt APIs reject invalid runtime actors and share only minimal payment candidates', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('katya'))[0]?.id);
    const invalid = 'outsider' as 'rodion';
    await assert.rejects(receipts.list(invalid), /receipt_actor_invalid/);
    await assert.rejects(receipts.image(invalid, id), /receipt_actor_invalid/);
    await assert.rejects(
      receipts.attach(invalid, id, id),
      /receipt_actor_invalid/,
    );
    await assert.rejects(receipts.candidates(invalid), /receipt_actor_invalid/);
    await assert.rejects(receipts.match(id, invalid), /receipt_actor_invalid/);
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','katya','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET','pending')",
    );
    const candidates = await receipts.candidates('rodion', 'market');
    assert.equal(candidates.length, 1);
    assert.deepEqual(
      Object.keys(candidates[0]!).sort(),
      [
        'id',
        'owner',
        'description',
        'amountMinor',
        'currency',
        'bookedAt',
        'status',
      ].sort(),
    );
    assert.equal(candidates[0]!.owner, 'katya');
    assert.equal(candidates[0]!.status, 'pending');
    assert.equal((await receipts.candidates('katya', 'absent')).length, 0);
    assert.equal(
      await receipts.attach('katya', id, String(candidates[0]!.id)),
      true,
    );
    const attached = (await receipts.list('rodion'))[0]!;
    assert.equal(attached.owner, 'rodion');
    assert.equal(attached.transaction_owner, 'katya');
    assert.equal(
      (await db.query('SELECT actor FROM receipt_attachment_events')).rows[0]
        ?.actor,
      'katya',
    );
  } finally {
    await db.close();
  }
});
test('Monobank original purchase requires exact bank-supplied signed minor units and currency', async () => {
  for (const scenario of [
    'exact',
    'absent',
    'float',
    'positive',
    'wrong_currency',
    'wrong_amount',
    'string',
    'pending',
    'wrong_day',
    'wrong_merchant',
    'other_provider',
    'collision',
  ]) {
    const { db, receipts } = await setup();
    try {
      const details = { operationAmount: -1234, currencyCode: 978 } as Record<
        string,
        unknown
      >;
      if (scenario === 'absent') delete details.operationAmount;
      if (scenario === 'float') details.operationAmount = -1234.5;
      if (scenario === 'positive') details.operationAmount = 1234;
      if (scenario === 'wrong_currency') details.currencyCode = 840;
      if (scenario === 'wrong_amount') details.operationAmount = -1235;
      if (scenario === 'string') details.operationAmount = '-1234';
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status,source_details) VALUES('00000000-0000-4000-8000-000000000001',$1,'1','a','katya',$2,'UAH',-56789,$3,$4,$5::jsonb)",
        [
          scenario === 'other_provider' ? 'test' : 'monobank',
          scenario === 'wrong_day'
            ? '2026-09-09T12:00:00Z'
            : '2026-09-10T12:00:00Z',
          scenario === 'wrong_merchant' ? 'OTHER MARKET' : 'TEST MARKET',
          scenario === 'pending' ? 'pending' : 'booked',
          JSON.stringify(details),
        ],
      );
      if (scenario === 'collision')
        await db.query(
          "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000002','test','2','b','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
        );
      await receipts.receive(settings, update());
      await receipts.processOne(options);
      assert.equal(
        (await receipts.list('rodion'))[0]?.state,
        // A Monobank hold settles as a revision of the same row, so it is a
        // candidate like a booked debit (ADR 0005).
        scenario === 'exact' || scenario === 'pending' ? 'matched' : 'pending',
        scenario,
      );
    } finally {
      await db.close();
    }
  }
});

test('merchant normalization handles Latvian legal prefix and terminal domain without fuzzy names', async () => {
  const { db, receipts } = await setup();
  try {
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','katya','2026-09-10T12:00:00Z','EUR',-1234,'EXAMPLE')",
    );
    for (const [index, merchant] of [
      'SIA "Example.lv"',
      'SIA "Different.lv"',
    ].entries()) {
      await receipts.receive(settings, update(-10, 10, index + 1));
      await receipts.processOne({
        ...options,
        request: async () => reply({ ...extraction, merchant }),
      });
    }
    const rows = await receipts.list('rodion');
    assert.equal(
      rows.find(
        (row) =>
          (row.extraction as typeof extraction).merchant === 'SIA "Example.lv"',
      )?.state,
      'matched',
    );
    assert.equal(
      rows.find(
        (row) =>
          (row.extraction as typeof extraction).merchant ===
          'SIA "Different.lv"',
      )?.state,
      'pending',
    );
  } finally {
    await db.close();
  }
});

test('receipt state constraint accepts the deletion tombstone and still rejects unknown states', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await db.query("UPDATE receipt_jobs SET state='duplicate'");
    assert.equal(
      (await db.query('SELECT state FROM receipt_jobs')).rows[0]?.state,
      'duplicate',
    );
    await db.query("UPDATE receipt_jobs SET state='deleted'");
    assert.equal(
      (await db.query('SELECT state FROM receipt_jobs')).rows[0]?.state,
      'deleted',
    );
    // The named constraint is the one in force, so the idempotent drop/add worked.
    await assert.rejects(
      db.query("UPDATE receipt_jobs SET state='bogus'"),
      /receipt_jobs_state_check/,
    );
  } finally {
    await db.close();
  }
});
test('deleting a receipt removes the photo and extraction but keeps the shared cost ledger row', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('rodion'))[0]!.id);
    assert.equal(await receipts.delete('rodion', id), 'deleted');
    assert.equal((await receipts.list('rodion')).length, 0);
    assert.equal(await receipts.image('rodion', id), null);
    const row = (
      await db.query(
        'SELECT state,extraction,image,reason,transaction_id FROM receipt_jobs WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    assert.equal(row.state, 'deleted');
    assert.equal(row.extraction, null);
    assert.equal(row.image, null);
    assert.equal(row.reason, 'owner_deleted');
    const ledger = (
      await db.query('SELECT state FROM llm_cost_ledger WHERE receipt_id=$1', [
        id,
      ])
    ).rows;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.state, 'measured');
  } finally {
    await db.close();
  }
});
test('deleting a matched receipt detaches the payment, audits it and keeps attachment history', async () => {
  const { db, receipts } = await setup();
  try {
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET 01')",
    );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const matched = (await receipts.list('rodion'))[0]!;
    assert.equal(matched.state, 'matched');
    const id = String(matched.id),
      transactionId = String(matched.transaction_id);
    assert.equal(await receipts.delete('katya', id), 'deleted');
    assert.equal(
      (
        await db.query('SELECT transaction_id FROM receipt_jobs WHERE id=$1', [
          id,
        ])
      ).rows[0]?.transaction_id,
      null,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE transaction_id=$1 AND event='receipt_detached'",
          [transactionId],
        )
      ).rows[0]?.n,
      1,
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM receipt_attachment_events WHERE receipt_id=$1',
          [id],
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});
function recordingTransport() {
  const calls: unknown[][] = [];
  return {
    calls,
    transport: {
      react: async (...a: unknown[]) => {
        calls.push(['react', ...a]);
      },
      reply: async (...a: unknown[]) => {
        calls.push(['reply', ...a]);
        return { messageId: 99 };
      },
    },
  };
}
const failingTransport = {
  react: async () => {
    throw new Error('telegram_uncertain');
  },
  reply: async (): Promise<{ messageId: number }> => {
    throw new Error('telegram_uncertain');
  },
};
const feedbackRow = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
  (
    await db.query(
      'SELECT feedback_state,feedback_attempts,(feedback_after>now()) AS later FROM receipt_jobs',
    )
  ).rows[0]!;

test('pending photo is acknowledged with eyes and upgraded to thumbs up once matched', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls, [['react', '-10', 1, '👀']]);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET 01')",
    );
    assert.equal(await receipts.retryPendingMatches(), 1);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'matched');
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls[1], ['react', '-10', 1, '👍']);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    assert.equal(t.calls.length, 2);
    assert.equal((await feedbackRow(db)).feedback_state, 'matched');
  } finally {
    await db.close();
  }
});
test('deletion is refused while the photo is being read and repeated deletion is not found', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('rodion'))[0]!.id);
    await db.query("UPDATE receipt_jobs SET state='processing' WHERE id=$1", [
      id,
    ]);
    assert.equal(await receipts.delete('rodion', id), 'busy');
    const busy = (
      await db.query(
        'SELECT state,extraction,reason FROM receipt_jobs WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    assert.equal(busy.state, 'processing');
    assert.deepEqual(busy.extraction, extraction);
    assert.equal(busy.reason, null);
    await db.query("UPDATE receipt_jobs SET state='pending' WHERE id=$1", [id]);
    assert.equal(await receipts.delete('rodion', id), 'deleted');
    assert.equal(await receipts.delete('rodion', id), 'not_found');
    assert.equal(
      await receipts.delete('rodion', '00000000-0000-4000-8000-0000000000ff'),
      'not_found',
    );
    await assert.rejects(
      receipts.delete('nobody' as 'rodion', id),
      /receipt_actor_invalid/,
    );
  } finally {
    await db.close();
  }
});
test('manual attachment of a pending receipt is acknowledged with thumbs up', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    for (const id of ['1', '2'])
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES($1,'test',$2,'a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET')",
        [`00000000-0000-4000-8000-00000000000${id}`, id],
      );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('rodion'))[0]?.id);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
    assert.equal(
      await receipts.attach(
        'rodion',
        id,
        '00000000-0000-4000-8000-000000000002',
      ),
      true,
    );
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls, [['react', '-10', 1, '👍']]);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
  } finally {
    await db.close();
  }
});

test('non-receipt and failed photos get one plain reply that leaks no receipt content', async () => {
  for (const [run, expected] of [
    [
      {
        ...options,
        request: async () => reply({ ...extraction, isReceipt: false }),
      },
      'This photo does not look like a receipt, so it was not saved.',
    ],
    [
      {
        ...options,
        request: async () => {
          throw new Error('network');
        },
      },
      'I could not read this receipt. Please send a clearer photo, or link the payment in the app.',
    ],
  ] as const) {
    const { db, receipts } = await setup();
    const t = recordingTransport();
    try {
      await receipts.receive(settings, update());
      await receipts.processOne(run);
      assert.equal(await receipts.notifyOne(t.transport), 'sent');
      assert.equal(t.calls.length, 1);
      assert.deepEqual(t.calls[0], ['reply', '-10', 1, expected]);
      const text = String(t.calls[0]![3]);
      assert.equal(text.includes(extraction.merchant), false);
      assert.equal(text.includes(extraction.amountMinor), false);
      assert.equal(text.includes(extraction.items[0]!), false);
      assert.equal(text.includes('extraction_failed'), false);
      assert.equal(await receipts.notifyOne(t.transport), 'idle');
    } finally {
      await db.close();
    }
  }
});

test('feedback retries are bounded, backed off and never block receipt processing', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal(await receipts.notifyOne(failingTransport), 'uncertain');
    assert.deepEqual(await feedbackRow(db), {
      feedback_state: null,
      feedback_attempts: 1,
      later: true,
    });
    assert.equal(await receipts.notifyOne(failingTransport), 'idle');
    for (let attempt = 2; attempt <= 5; attempt++) {
      await db.query(
        "UPDATE receipt_jobs SET feedback_after=now()-interval '1 second'",
      );
      assert.equal(await receipts.notifyOne(failingTransport), 'uncertain');
      assert.equal((await feedbackRow(db)).feedback_attempts, attempt);
    }
    for (let i = 0; i < 3; i++) {
      await db.query(
        "UPDATE receipt_jobs SET feedback_after=now()-interval '1 second'",
      );
      assert.equal(await receipts.notifyOne(t.transport), 'idle');
    }
    assert.equal(t.calls.length, 0);
    assert.equal((await feedbackRow(db)).feedback_state, null);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
  } finally {
    await db.close();
  }
});

test('enabling feedback backfills existing receipts once and never notifies them', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
    await db.query(
      'ALTER TABLE receipt_jobs DROP COLUMN feedback_state,DROP COLUMN feedback_attempts,DROP COLUMN feedback_after',
    );
    await db.transaction(initializeReceipts);
    assert.deepEqual(await feedbackRow(db), {
      feedback_state: 'pending',
      feedback_attempts: 0,
      later: null,
    });
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    await db.transaction(initializeReceipts);
    assert.equal((await feedbackRow(db)).feedback_state, 'pending');
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    assert.equal(t.calls.length, 0);
  } finally {
    await db.close();
  }
});

test('merchant tokens ignore legal form and geography without inventing aliases', () => {
  assert.deepEqual(merchantTokens('SIA RIMI LATVIA'), ['rimi']);
  assert.deepEqual(merchantTokens('SIA "Cydonia.lv"'), ['cydonia']);
  assert.deepEqual(merchantTokens('SIA Latvia'), []);
  const description = 'RIMI MR Marijas (Riga)';
  assert.equal(merchantMatches('SIA RIMI LATVIA', description), true);
  assert.equal(merchantMatches('Rimi', description), true);
  assert.equal(merchantMatches('SIA "Cydonia.lv"', 'CYDONIA RIGA'), true);
  assert.equal(merchantMatches('Maxima', description), false);
  // Nothing but stop-words falls back to the old containment rule, which cannot
  // turn a country name into evidence about a shop.
  assert.equal(merchantMatches('SIA Latvia', 'RIMI'), false);
  // A three-letter brand must be a whole word, so it never matches inside another.
  assert.equal(merchantMatches('IKI', 'IKI PARDUOTUVE'), true);
  assert.equal(merchantMatches('IKI', 'PIKIS'), false);
});

test('a shared token links the registered name to the card description, a different brand does not', async () => {
  for (const [description, expected] of [
    ['TEST MR CENTRAL (RIGA)', 'matched'],
    ['OTHER MR CENTRAL (RIGA)', 'pending'],
  ] as const) {
    const { db, receipts } = await setup();
    try {
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,$1)",
        [description],
      );
      await receipts.receive(settings, update());
      await receipts.processOne({
        ...options,
        request: async () =>
          reply({ ...extraction, merchant: 'SIA TEST LATVIA' }),
      });
      assert.equal(
        (await receipts.list('rodion'))[0]?.state,
        expected,
        description,
      );
    } finally {
      await db.close();
    }
  }
});

test('Enable Banking bookings match a three-day window; exact-instant sources keep the exact day', async () => {
  for (const [name, rows, expected] of [
    ['enablebanking +2 days', [['enablebanking', '2026-09-12']], 'matched'],
    ['enablebanking +3 days', [['enablebanking', '2026-09-13']], 'matched'],
    ['enablebanking +4 days', [['enablebanking', '2026-09-14']], 'pending'],
    ['monobank +1 day', [['monobank', '2026-09-11']], 'pending'],
    ['monobank same day', [['monobank', '2026-09-10']], 'matched'],
    [
      'two bookings in the window',
      [
        ['enablebanking', '2026-09-11'],
        ['enablebanking', '2026-09-12'],
      ],
      'pending',
    ],
  ] as const) {
    const { db, receipts } = await setup();
    try {
      for (const [index, [source, day]] of rows.entries())
        await db.query(
          // Enable Banking stores a booking calendar day as UTC midnight.
          "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES($1,$2,$3,'a','rodion',$4::timestamptz,'EUR',-1234,'TEST MARKET')",
          [
            `00000000-0000-4000-8000-00000000000${index + 1}`,
            source,
            String(index + 1),
            source === 'monobank' ? `${day}T12:00:00Z` : `${day}T00:00:00.000Z`,
          ],
        );
      await receipts.receive(settings, update());
      await receipts.processOne(options);
      assert.equal((await receipts.list('rodion'))[0]?.state, expected, name);
    } finally {
      await db.close();
    }
  }
});

test('the same photo sent twice is marked duplicate before any model call or cost row', async () => {
  const { db, receipts } = await setup();
  try {
    let calls = 0;
    const run = {
      ...sameImage,
      request: async () => {
        calls++;
        return reply();
      },
    };
    await receipts.receive(settings, update());
    await receipts.processOne(run);
    await receipts.receive(settings, update(-10, 20, 2));
    assert.equal(await receipts.processOne(run), true);
    assert.equal(calls, 1);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM llm_cost_ledger')).rows[0]
        ?.n,
      1,
    );
    const jobs = (
      await db.query(
        'SELECT id,owner,state,reason,duplicate_of,image,image_sha256 FROM receipt_jobs ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]?.state, 'pending');
    assert.equal(jobs[1]?.state, 'duplicate');
    assert.equal(jobs[1]?.reason, 'duplicate_image');
    assert.equal(jobs[1]?.duplicate_of, jobs[0]?.id);
    assert.equal(jobs[1]?.image, null);
    assert.equal(jobs[1]?.image_sha256, jobs[0]?.image_sha256);
  } finally {
    await db.close();
  }
});

test('a second photo of the same purchase is marked duplicate, answered once and never re-matched', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne({
      ...options,
      request: async () =>
        reply({ ...extraction, merchant: 'SIA TEST LATVIA' }),
    });
    await receipts.receive(settings, update(-10, 20, 2));
    await receipts.processOne({
      ...options,
      request: async () => reply({ ...extraction, merchant: 'TEST MR' }),
    });
    const jobs = (
      await db.query(
        'SELECT id,state,reason,duplicate_of,image IS NOT NULL AS kept FROM receipt_jobs ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(jobs[0]?.state, 'pending');
    assert.equal(jobs[0]?.reason, null);
    assert.equal(jobs[1]?.state, 'duplicate');
    assert.equal(jobs[1]?.reason, 'duplicate_receipt');
    assert.equal(jobs[1]?.duplicate_of, jobs[0]?.id);
    // The owner may want to compare the two photos, so this image is kept.
    assert.equal(jobs[1]?.kept, true);
    // Only the pending receipt is swept; the duplicate is never linked later.
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MR CENTRAL')",
    );
    assert.equal(await receipts.retryPendingMatches(), 1);
    const after = (
      await db.query(
        'SELECT state,transaction_id FROM receipt_jobs ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(after[0]?.state, 'matched');
    assert.equal(after[1]?.state, 'duplicate');
    assert.equal(after[1]?.transaction_id, null);
    const duplicateText =
      'This looks like a receipt you already sent (same merchant, date and total), so it was not linked again. You can delete it in the app.';
    for (let i = 0; i < 4; i++) await receipts.notifyOne(t.transport);
    const replies = t.calls.filter((call) => call[0] === 'reply');
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], ['reply', '-10', 2, duplicateText]);
    // The reply is a fixed constant and leaks no extracted evidence.
    assert.equal(duplicateText.includes(extraction.merchant), false);
    assert.equal(duplicateText.includes(extraction.amountMinor), false);
    assert.equal(duplicateText.includes('duplicate_receipt'), false);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
  } finally {
    await db.close();
  }
});

test('an owner can delete a duplicate receipt', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(sameImage);
    await receipts.receive(settings, update(-10, 20, 2));
    await receipts.processOne(sameImage);
    const duplicate = (
      await db.query("SELECT id FROM receipt_jobs WHERE state='duplicate'")
    ).rows[0]!;
    assert.equal(
      await receipts.delete('rodion', String(duplicate.id)),
      'deleted',
    );
    assert.equal(
      (
        await db.query('SELECT state FROM receipt_jobs WHERE id=$1', [
          duplicate.id,
        ])
      ).rows[0]?.state,
      'deleted',
    );
  } finally {
    await db.close();
  }
});

test('a payment that already carries a receipt never gains a second automatic link', async () => {
  const { db, receipts } = await setup();
  try {
    // Two receipts for one purchase already on file, as they can be after an
    // upgrade: intake duplicate detection never saw them, so only the matching
    // guard can stop the sweep from linking both to the same payment.
    const twin = {
      ...extraction,
      merchant: 'SIA TEST MARKET LATVIA',
      amountMinor: '1234',
    };
    for (const [message, value] of [
      [1, extraction],
      [2, twin],
    ] as const) {
      await receipts.receive(settings, update(-10, 10, message));
      await db.query(
        "UPDATE receipt_jobs SET state='pending',extraction=$2::jsonb WHERE message_id=$1",
        [message, JSON.stringify(value)],
      );
    }
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-000000000001','test','1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET 01')",
    );
    await receipts.retryPendingMatches();
    const rows = (
      await db.query(
        'SELECT id,state,reason,transaction_id,duplicate_of FROM receipt_jobs ORDER BY message_id',
      )
    ).rows;
    assert.equal(rows[0]?.state, 'matched');
    assert.equal(rows[1]?.state, 'duplicate');
    assert.equal(rows[1]?.reason, 'duplicate_payment');
    assert.equal(rows[1]?.transaction_id, null);
    // The tombstone points at the receipt that legitimately holds the payment.
    assert.equal(rows[1]?.duplicate_of, rows[0]?.id);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM receipt_jobs WHERE state='matched'",
        )
      ).rows[0]?.n,
      1,
    );
    // A marked duplicate is outside the attach contract too, so neither the
    // automatic sweep nor the API can produce a second link to this payment.
    assert.equal(
      await receipts.attach(
        'rodion',
        String(rows[1]!.id),
        '00000000-0000-4000-8000-000000000001',
      ),
      false,
    );
  } finally {
    await db.close();
  }
});
test('the receipt migration is idempotent and never re-runs the feedback backfill', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const snapshot = async () =>
      (
        await db.query(
          'SELECT state,feedback_state,feedback_attempts,reason FROM receipt_jobs ORDER BY id',
        )
      ).rows;
    const before = await snapshot();
    // initializeReceipts runs at every service start, so a second and third run
    // must change nothing -- including not re-acknowledging owed feedback.
    await db.transaction(initializeReceipts);
    await db.transaction(initializeReceipts);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      await receipts.notifyOne(recordingTransport().transport),
      'sent',
    );
  } finally {
    await db.close();
  }
});

const holdId = '00000000-0000-4000-8000-0000000000c1';
const insertHold = (
  db: Awaited<ReturnType<typeof setup>>['db'],
  source = 'monobank',
  status = 'pending',
  id = holdId,
  amountMinor = -1234,
  bookedAt = '2026-09-10T12:00:00Z',
) =>
  db.query(
    `INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status)
     VALUES($1,$2,$3,'a','rodion',$4::timestamptz,'EUR',$5,'TEST MARKET 01',$6)`,
    [id, source, id.slice(-2), bookedAt, amountMinor, status],
  );
/** Settlement as the bank actually delivers it for an in-place source: the same
 * row, a new revision, no second transaction and no rewritten history. */
const settle = (
  db: Awaited<ReturnType<typeof setup>>['db'],
  amountMinor = -1234,
  currency = 'EUR',
) =>
  db.query(
    `UPDATE transactions SET status='booked',amount_minor=$1,currency=$2,
     revision=revision+1,updated_at=now() WHERE id=$3`,
    [amountMinor, currency, holdId],
  );
const receiptRow = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
  (
    await db.query(
      'SELECT state,transaction_id,settlement_difference,feedback_state FROM receipt_jobs ORDER BY message_id LIMIT 1',
    )
  ).rows[0]!;

test('a Monobank hold is linked automatically while the payment is still pending', async () => {
  const { db, receipts } = await setup();
  try {
    await insertHold(db);
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const row = await receiptRow(db);
    assert.equal(row.state, 'matched');
    assert.equal(row.transaction_id, holdId);
    assert.equal(row.settlement_difference, null);
    // The hold itself is untouched: money and bank records are never rewritten.
    assert.deepEqual(
      (
        await db.query(
          'SELECT status,amount_minor::text AS amount,revision FROM transactions WHERE id=$1',
          [holdId],
        )
      ).rows[0],
      { status: 'pending', amount: '-1234', revision: 0 },
    );
  } finally {
    await db.close();
  }
});

test('an Enable Banking hold is linked too: one rule for every bank', async () => {
  for (const status of ['pending', 'booked'] as const) {
    const { db, receipts } = await setup();
    try {
      // Enable Banking stores a booking calendar day as UTC midnight.
      await insertHold(
        db,
        'enablebanking',
        status,
        holdId,
        -1234,
        '2026-09-10T00:00:00.000Z',
      );
      await receipts.receive(settings, update());
      await receipts.processOne(options);
      const row = await receiptRow(db);
      assert.equal(row.state, 'matched', status);
      assert.equal(row.transaction_id, holdId, status);
    } finally {
      await db.close();
    }
  }
});

test('a hold and a booked debit for the same amount and day stay ambiguous', async () => {
  const { db, receipts } = await setup();
  try {
    await insertHold(db, 'monobank', 'pending');
    await insertHold(
      db,
      'monobank',
      'booked',
      '00000000-0000-4000-8000-0000000000c2',
    );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const row = await receiptRow(db);
    assert.equal(row.state, 'pending');
    assert.equal(row.transaction_id, null);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM receipt_attachment_events',
        )
      ).rows[0]?.n,
      0,
    );
  } finally {
    await db.close();
  }
});

test('a hold that settles at the same amount records no difference and says nothing more', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await insertHold(db);
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls, [['react', '-10', 1, '👍']]);
    await settle(db);
    assert.equal(await receipts.reviewSettledMatches(), 0);
    const row = await receiptRow(db);
    assert.equal(row.state, 'matched');
    assert.equal(row.transaction_id, holdId);
    assert.equal(row.settlement_difference, null);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    assert.equal(t.calls.length, 1);
  } finally {
    await db.close();
  }
});

test('a settlement at another amount is recorded, keeps the link and is announced once', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await insertHold(db);
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    // A tip added at settlement: the same row, a new revision, a bigger amount.
    await settle(db, -1500);
    assert.equal(await receipts.reviewSettledMatches(), 1);
    const row = await receiptRow(db);
    // The evidence still stands: the link and the state are untouched.
    assert.equal(row.state, 'matched');
    assert.equal(row.transaction_id, holdId);
    assert.deepEqual(row.settlement_difference, {
      receiptAmountMinor: '1234',
      receiptCurrency: 'EUR',
      paymentAmountMinor: '-1500',
      paymentCurrency: 'EUR',
      detectedAtRevision: '1',
      // An automatic link owes the owner an explanation, so it is announced.
      attachedBy: 'automatic',
    });
    // The payment keeps exactly what the bank said.
    assert.deepEqual(
      (
        await db.query(
          'SELECT status,amount_minor::text AS amount,revision FROM transactions WHERE id=$1',
          [holdId],
        )
      ).rows[0],
      { status: 'booked', amount: '-1500', revision: 1 },
    );
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    const difference =
      'This payment settled at a different amount than the receipt total. The receipt is still linked; please check it in the app.';
    assert.deepEqual(t.calls[1], ['reply', '-10', 1, difference]);
    assert.equal(t.calls.length, 2);
    // A fixed constant: no merchant, no amount, no item, no reason code.
    assert.equal(difference.includes(extraction.merchant), false);
    assert.equal(difference.includes(extraction.amountMinor), false);
    assert.equal(difference.includes('1500'), false);
    assert.equal(difference.includes(extraction.items[0]!), false);
    assert.equal(difference.includes('settlement_difference'), false);
    // The same difference is answered once, and re-running the sweep is a no-op.
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    assert.equal(await receipts.reviewSettledMatches(), 0);
    assert.equal(await receipts.notifyOne(t.transport), 'idle');
    assert.equal(t.calls.length, 2);
  } finally {
    await db.close();
  }
});

test('a settlement difference the bank later corrects is cleared', async () => {
  const { db, receipts } = await setup();
  try {
    await insertHold(db);
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    await settle(db, -1500);
    assert.equal(await receipts.reviewSettledMatches(), 1);
    assert.ok((await receiptRow(db)).settlement_difference);
    await settle(db, -1234);
    assert.equal(await receipts.reviewSettledMatches(), 1);
    const row = await receiptRow(db);
    assert.equal(row.settlement_difference, null);
    assert.equal(row.state, 'matched');
    assert.equal(row.transaction_id, holdId);
    assert.equal(await receipts.reviewSettledMatches(), 0);
  } finally {
    await db.close();
  }
});

test('a pending payment that already carries a receipt never gains a second link', async () => {
  const { db, receipts } = await setup();
  try {
    const twin = { ...extraction, merchant: 'SIA TEST MARKET LATVIA' };
    for (const [message, value] of [
      [1, extraction],
      [2, twin],
    ] as const) {
      await receipts.receive(settings, update(-10, 10, message));
      await db.query(
        "UPDATE receipt_jobs SET state='pending',extraction=$2::jsonb WHERE message_id=$1",
        [message, JSON.stringify(value)],
      );
    }
    await insertHold(db);
    await receipts.retryPendingMatches();
    const rows = (
      await db.query(
        'SELECT id,state,reason,transaction_id,duplicate_of FROM receipt_jobs ORDER BY message_id',
      )
    ).rows;
    assert.equal(rows[0]?.state, 'matched');
    assert.equal(rows[0]?.transaction_id, holdId);
    assert.equal(rows[1]?.state, 'duplicate');
    assert.equal(rows[1]?.reason, 'duplicate_payment');
    assert.equal(rows[1]?.transaction_id, null);
    assert.equal(rows[1]?.duplicate_of, rows[0]?.id);
  } finally {
    await db.close();
  }
});

// A bank that changes its row reference at settlement reports the settled
// purchase as a second row instead of revising the hold, which would strand the
// receipt on a row that never settles.
const settledId = '00000000-0000-4000-8000-0000000000e1';
const insertSettled = (
  db: Awaited<ReturnType<typeof setup>>['db'],
  id = settledId,
  description = 'TEST MARKET 01',
) =>
  insertHold(
    db,
    'enablebanking',
    'booked',
    id,
    -1234,
    '2026-09-11T00:00:00.000Z',
  ).then(() =>
    db.query('UPDATE transactions SET description=$2 WHERE id=$1', [
      id,
      description,
    ]),
  );
async function receiptOnHold() {
  const context = await setup();
  await insertHold(
    context.db,
    'enablebanking',
    'pending',
    holdId,
    -1234,
    '2026-09-10T00:00:00.000Z',
  );
  await context.receipts.receive(settings, update());
  await context.receipts.processOne(options);
  assert.equal((await receiptRow(context.db)).transaction_id, holdId);
  return context;
}

test('a receipt stranded on a hold moves to the settled row that replaced it', async () => {
  const { db, receipts } = await receiptOnHold();
  try {
    await insertSettled(db);
    assert.equal(await receipts.reviewSettledMatches(), 1);
    const row = await receiptRow(db);
    assert.equal(row.state, 'matched');
    assert.equal(row.transaction_id, settledId);
    assert.equal(row.settlement_difference, null);
    // History explains the move and keeps the payment it came from.
    const events = (
      await db.query(
        'SELECT actor,previous_transaction_id,transaction_id FROM receipt_attachment_events ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      actor: 'automatic',
      previous_transaction_id: holdId,
      transaction_id: settledId,
    });
    assert.equal(
      (await db.query('SELECT reason FROM receipt_jobs ORDER BY message_id'))
        .rows[0]?.reason,
      'settled_row_replaced_pending',
    );
    // Neither bank row was rewritten, and the hold keeps no receipt.
    assert.deepEqual(
      (
        await db.query(
          'SELECT status,amount_minor::text AS amount FROM transactions WHERE id=$1',
          [holdId],
        )
      ).rows[0],
      { status: 'pending', amount: '-1234' },
    );
    assert.equal(await receipts.reviewSettledMatches(), 0);
  } finally {
    await db.close();
  }
});

test('a settled row that already carries a receipt never takes a second one', async () => {
  const { db, receipts } = await receiptOnHold();
  try {
    await insertSettled(db);
    await db.query(
      `INSERT INTO receipt_jobs(id,owner,chat_id,message_id,file_id,state,transaction_id,extraction)
       VALUES('00000000-0000-4000-8000-0000000000f1','katya','-10',99,'f9','matched',$1,$2::jsonb)`,
      [settledId, JSON.stringify(extraction)],
    );
    assert.equal(await receipts.reviewSettledMatches(), 0);
    assert.equal((await receiptRow(db)).transaction_id, holdId);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM receipt_attachment_events',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('an attachment a person made by hand is never moved automatically', async () => {
  const { db, receipts } = await setup();
  try {
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    assert.equal((await receiptRow(db)).state, 'pending');
    await insertHold(
      db,
      'enablebanking',
      'pending',
      holdId,
      -1234,
      '2026-09-10T00:00:00.000Z',
    );
    const id = String((await receipts.list('rodion'))[0]?.id);
    assert.equal(await receipts.attach('rodion', id, holdId), true);
    await insertSettled(db);
    assert.equal(await receipts.reviewSettledMatches(), 0);
    assert.equal((await receiptRow(db)).transaction_id, holdId);
    assert.equal(
      (
        await db.query(
          'SELECT actor FROM receipt_attachment_events ORDER BY created_at DESC,id DESC LIMIT 1',
        )
      ).rows[0]?.actor,
      'rodion',
    );
  } finally {
    await db.close();
  }
});

test('an attachment whose payment has settled in place is never second-guessed', async () => {
  const { db, receipts } = await receiptOnHold();
  try {
    // The ordinary case: the same row becomes booked, so nothing may move even
    // though another matching booked row also exists.
    await db.query(
      "UPDATE transactions SET status='booked',revision=revision+1,updated_at=now() WHERE id=$1",
      [holdId],
    );
    await insertSettled(db);
    assert.equal(await receipts.reviewSettledMatches(), 0);
    assert.equal((await receiptRow(db)).transaction_id, holdId);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM receipt_attachment_events',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('two settled candidates are ambiguous, so a stranded receipt stays put', async () => {
  const { db, receipts } = await receiptOnHold();
  try {
    await insertSettled(db);
    await insertSettled(db, '00000000-0000-4000-8000-0000000000e2');
    assert.equal(await receipts.reviewSettledMatches(), 0);
    assert.equal((await receiptRow(db)).transaction_id, holdId);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM receipt_attachment_events',
        )
      ).rows[0]?.n,
      1,
    );
  } finally {
    await db.close();
  }
});

test('a difference on a hand-made link is recorded and shown but never announced', async () => {
  const { db, receipts } = await setup();
  const t = recordingTransport();
  try {
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status) VALUES('00000000-0000-4000-8000-000000000001','monobank','1','a','rodion','2026-09-10T12:00:00Z','EUR',-9999,'SOMEWHERE ELSE','booked')",
    );
    await receipts.receive(settings, update());
    await receipts.processOne(options);
    const id = String((await receipts.list('rodion'))[0]!.id);
    // The owner deliberately links a receipt to a payment of another amount.
    assert.equal(
      await receipts.attach(
        'rodion',
        id,
        '00000000-0000-4000-8000-000000000001',
      ),
      true,
    );
    await db.query(
      "UPDATE transactions SET revision=revision+1,updated_at=now() WHERE id='00000000-0000-4000-8000-000000000001'",
    );
    assert.equal(await receipts.reviewSettledMatches(), 1);
    const row = (
      await db.query(
        'SELECT settlement_difference AS d,state,transaction_id FROM receipt_jobs WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    const difference = row.d as Record<string, string>;
    // Recorded and visible, so the app can show it...
    assert.equal(difference.paymentAmountMinor, '-9999');
    assert.equal(difference.attachedBy, 'rodion');
    assert.equal(row.state, 'matched');
    assert.ok(row.transaction_id);
    // ...but the owner chose this link, so the bot stays quiet about it.
    await receipts.notifyOne(t.transport);
    assert.equal(
      t.calls.some((c) =>
        String(c[3] ?? '').includes('settled at a different'),
      ),
      false,
    );
  } finally {
    await db.close();
  }
});

test('a brand abbreviation matches the registered name it stands for, but not a look-alike', () => {
  // A bank prints "H&M" where the receipt prints the registered name. Its letters
  // survive only as one- and two-character fragments, so the token rule is blind
  // to them; a prefix comparison sees it. Observed on a real unmatched receipt.
  assert.equal(merchantMatches('H&M Hennes & Mauritz', 'H&M'), true);
  assert.equal(merchantMatches('H&M', 'H&M Hennes & Mauritz'), true);
  // A prefix, never a substring: sharing a beginning is not sharing a name.
  assert.equal(merchantMatches('Rimi', 'RIMAC'), false);
  assert.equal(merchantMatches('Apotheka', 'APOTEKA'), false);
  assert.equal(merchantMatches('Maxima', 'RIMI MR Marijas'), false);
  // Existing behaviour is unchanged.
  assert.equal(
    merchantMatches('SIA RIMI LATVIA', 'RIMI MR Marijas (Riga)'),
    true,
  );
  assert.equal(merchantMatches('IKI', 'PIKIS'), false);
});
test('an abbreviated bank description links a pending payment end to end', () => {
  return (async () => {
    const { db, receipts } = await setup();
    try {
      await db.query(
        "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description,status) VALUES('00000000-0000-4000-8000-0000000000e1','monobank','e1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'H&M','pending')",
      );
      await receipts.receive(settings, update());
      await receipts.processOne({
        ...options,
        request: async () =>
          reply({ ...extraction, merchant: 'H&M Hennes & Mauritz' }),
      });
      const row = (await receipts.list('rodion'))[0]!;
      assert.equal(row.state, 'matched');
      assert.equal(row.transaction_id, '00000000-0000-4000-8000-0000000000e1');
    } finally {
      await db.close();
    }
  })();
});

test('a PDF document is accepted at intake and an unknown document type is still ignored', async () => {
  const { db, receipts } = await setup();
  try {
    assert.equal(await receipts.receive(settings, pdfDocumentUpdate()), true);
    assert.equal(
      await receipts.receive(
        settings,
        pdfDocumentUpdate(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          2,
        ),
      ),
      false,
    );
    assert.equal(
      await receipts.receive(settings, pdfDocumentUpdate('image/png', 3)),
      true,
    );
    const rows = await receipts.list('rodion');
    assert.equal(rows.length, 2);
  } finally {
    await db.close();
  }
});

test('the downloader accepts a PDF body at a .pdf path and rejects anything the bytes contradict', async () => {
  const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
  const fetcher = (path: string, body: Buffer) => {
    let call = 0;
    return async () =>
      call++ === 0
        ? new Response(
            JSON.stringify({
              ok: true,
              result: { file_path: path, file_size: body.length },
            }),
          )
        : new Response(new Uint8Array(body));
  };
  const pdf = Buffer.from('%PDF-1.7\nsynthetic', 'ascii');
  const downloaded = await receiptDownloader(
    token,
    fetcher('documents/file_1.pdf', pdf),
  )('x');
  assert.equal(downloaded.mime, 'application/pdf');
  assert.ok(downloaded.bytes.equals(pdf));
  // A .pdf name over bytes that are not a PDF is refused: only bytes decide.
  await assert.rejects(
    receiptDownloader(
      token,
      fetcher('documents/file_2.pdf', Buffer.from('<html>hi</html>', 'ascii')),
    )('x'),
    /receipt_download_failed/,
  );
  // An unknown extension stays rejected even when the bytes are a real PDF.
  await assert.rejects(
    receiptDownloader(token, fetcher('documents/file_3.docx', pdf))('x'),
    /receipt_download_failed/,
  );
  // A JPEG still downloads exactly as before.
  const jpeg = Buffer.from([255, 216, 255, 7]);
  assert.equal(
    (await receiptDownloader(token, fetcher('photos/file_4.jpg', jpeg))('x'))
      .mime,
    'image/jpeg',
  );
});

test('a single-page PDF is read, matched and stored as the original document with a rendered preview', async () => {
  const { db, receipts } = await setup();
  const run = pdfRun(1);
  try {
    await db.query(
      "INSERT INTO transactions(id,source,source_id,account_id,owner,booked_at,currency,amount_minor,description) VALUES('00000000-0000-4000-8000-0000000000f1','test','f1','a','rodion','2026-09-10T12:00:00Z','EUR',-1234,'TEST MARKET 01')",
    );
    await receipts.receive(settings, pdfDocumentUpdate());
    assert.equal(await receipts.processOne(run.run), true);
    assert.equal(run.images().length, 1);
    assert.equal(run.images()[0]?.detail, 'high');
    assert.equal(run.bodies[0]?.store, false);
    const row = (await receipts.list('rodion'))[0]!;
    assert.equal(row.state, 'matched');
    assert.deepEqual(row.extraction, extraction);
    assert.equal(row.mime, 'application/pdf');
    const stored = (
      await db.query(
        'SELECT image,mime,preview_image,preview_mime FROM receipt_jobs WHERE id=$1',
        [row.id],
      )
    ).rows[0]!;
    assert.ok(Buffer.from(stored.image as Uint8Array).equals(run.pdf));
    assert.equal(stored.mime, 'application/pdf');
    assert.equal(stored.preview_mime, 'image/png');
    assert.ok(
      Buffer.from(stored.preview_image as Uint8Array).equals(
        syntheticPage(1).bytes,
      ),
    );
  } finally {
    await db.close();
  }
});

test('a three-page PDF travels as three images in one request under one reservation', async () => {
  const { db, receipts } = await setup();
  const run = pdfRun(3);
  try {
    await receipts.receive(settings, pdfDocumentUpdate());
    await receipts.processOne(run.run);
    // One request, three ordered page images, and one reservation: the page
    // count cannot multiply the cost, because reservationCost replaces `input`
    // with a short string before pricing the body.
    assert.equal(run.bodies.length, 1);
    assert.equal(run.images().length, 3);
    assert.deepEqual(
      run.images().map((image) => image.image_url),
      [1, 2, 3].map(
        (page) =>
          `data:image/png;base64,${syntheticPage(page).bytes.toString('base64')}`,
      ),
    );
    const ledger = (
      await db.query('SELECT state,held_nano FROM llm_cost_ledger')
    ).rows;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.state, 'measured');
    assert.equal((await receipts.list('rodion'))[0]?.state, 'pending');
  } finally {
    await db.close();
  }
});

test('a PDF longer than the page cap is refused before any model call or reservation', async () => {
  const { db, receipts } = await setup();
  const run = pdfRun(9);
  const t = recordingTransport();
  try {
    await receipts.receive(settings, pdfDocumentUpdate());
    assert.equal(await receipts.processOne(run.run), true);
    assert.equal(run.bodies.length, 0);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM llm_cost_ledger')).rows[0]
        ?.n,
      0,
    );
    const row = (await receipts.list('rodion'))[0]!;
    assert.equal(row.state, 'failed');
    assert.equal(row.reason, 'receipt_pdf_too_many_pages');
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls[0], [
      'reply',
      '-10',
      1,
      'This PDF has too many pages to read. Please send the receipt page only.',
    ]);
  } finally {
    await db.close();
  }
});

test('a PDF that cannot be rendered fails before any model call or reservation', async () => {
  const { db, receipts } = await setup();
  let calls = 0;
  const t = recordingTransport();
  try {
    await receipts.receive(settings, pdfDocumentUpdate());
    assert.equal(
      await receipts.processOne({
        ...options,
        download: async () => ({
          bytes: syntheticPdf(),
          mime: 'application/pdf',
        }),
        rasterize: async () => {
          throw new Error('receipt_pdf_render_failed');
        },
        request: async () => {
          calls++;
          return reply();
        },
      }),
      true,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM llm_cost_ledger')).rows[0]
        ?.n,
      0,
    );
    const row = (await receipts.list('rodion'))[0]!;
    assert.equal(row.state, 'failed');
    assert.equal(row.reason, 'receipt_pdf_render_failed');
    assert.equal(await receipts.notifyOne(t.transport), 'sent');
    assert.deepEqual(t.calls[0], [
      'reply',
      '-10',
      1,
      'I could not read this PDF. Please send a photo of the receipt instead.',
    ]);
  } finally {
    await db.close();
  }
});

test('the same PDF sent twice is caught by the image digest before any model call', async () => {
  const { db, receipts } = await setup();
  const pdf = syntheticPdf();
  const first = pdfRun(1, pdf);
  const second = pdfRun(1, pdf);
  try {
    await receipts.receive(settings, pdfDocumentUpdate());
    await receipts.processOne(first.run);
    await receipts.receive(settings, pdfDocumentUpdate('application/pdf', 2));
    assert.equal(await receipts.processOne(second.run), true);
    // The duplicate is decided on the downloaded bytes, so the second document
    // is neither rendered nor sent to the model.
    assert.equal(second.bodies.length, 0);
    assert.equal(second.rasterizedCount(), 0);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM llm_cost_ledger')).rows[0]
        ?.n,
      1,
    );
    const jobs = (
      await db.query(
        'SELECT state,reason,duplicate_of,image,preview_image FROM receipt_jobs ORDER BY created_at,id',
      )
    ).rows;
    assert.equal(jobs[0]?.state, 'pending');
    assert.equal(jobs[1]?.state, 'duplicate');
    assert.equal(jobs[1]?.reason, 'duplicate_image');
    assert.equal(jobs[1]?.image, null);
    assert.equal(jobs[1]?.preview_image, null);
  } finally {
    await db.close();
  }
});

test('the viewer gets a renderable preview and the evidence link gets the original file', async () => {
  const { db, receipts } = await setup();
  const run = pdfRun(2);
  try {
    await receipts.receive(settings, pdfDocumentUpdate());
    await receipts.processOne(run.run);
    await receipts.receive(settings, update(-10, 20, 2));
    await receipts.processOne(options);
    const rows = await receipts.list('rodion');
    const pdfRow = rows.find((row) => row.mime === 'application/pdf')!;
    const photoRow = rows.find((row) => row.mime === 'image/jpeg')!;
    // A PDF shows its rendered first page; its original document stays the
    // evidence behind the link. Either family member may read both.
    const preview = await receipts.image('katya', String(pdfRow.id));
    assert.equal(preview?.mime, 'image/png');
    assert.ok(preview?.bytes.equals(syntheticPage(1).bytes));
    const file = await receipts.file('katya', String(pdfRow.id));
    assert.equal(file?.mime, 'application/pdf');
    assert.ok(file?.bytes.equals(run.pdf));
    // A photo is unchanged: it is its own preview and its own original.
    const photo = await receipts.image('rodion', String(photoRow.id));
    const photoFile = await receipts.file('rodion', String(photoRow.id));
    assert.equal(photo?.mime, 'image/jpeg');
    assert.deepEqual(photo, photoFile);
  } finally {
    await db.close();
  }
});
