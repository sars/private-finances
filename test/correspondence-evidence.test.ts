import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository, Conflict } from '../src/repository.js';
import {
  CorrespondenceEvidenceStore,
  gmailEvidenceSearch,
} from '../src/correspondence-evidence.js';
const input = {
  source: 'synthetic',
  accountId: 'a',
  sourceId: 'one',
  owner: 'rodion',
  bookedAt: '2026-08-31T22:00:00Z',
  currency: 'UAH',
  amountMinor: '-15010',
  description: 'Synthetic purchase',
};
test('evidence is owner-scoped, append-only audited context and becomes stale after revision changes', async () => {
  const db = memoryDatabase();
  await migrate(db);
  try {
    const repo = new Repository(db);
    await repo.importBatch([input]);
    const transaction = (await repo.list())[0]!;
    const evidence = new CorrespondenceEvidenceStore(db);
    assert.deepEqual(await evidence.list('rodion', transaction.id), []);
    const entry = {
      source: 'gmail' as const,
      reference: 'Invoice message on September 1',
      summary: 'Synthetic context, not a confirmed classification',
    };
    await assert.rejects(
      evidence.add('katya', transaction.id, 0, entry),
      /not_found/,
    );
    const note = await evidence.add('rodion', transaction.id, 0, entry);
    assert.equal(note.stale, false);
    assert.equal(note.transactionRevision, 0);
    assert.deepEqual((await repo.list())[0], transaction);
    assert.equal(
      (await repo.history(transaction.id)).filter(
        (x) => x.event === 'correspondence_evidence_added',
      ).length,
      1,
    );
    await assert.rejects(evidence.list('katya', transaction.id), /not_found/);
    await db.query('UPDATE transactions SET revision=revision+1 WHERE id=$1', [
      transaction.id,
    ]);
    assert.equal(
      (await evidence.list('rodion', transaction.id))[0]!.stale,
      true,
    );
    await assert.rejects(
      evidence.add('rodion', transaction.id, 0, entry),
      Conflict,
    );
    assert.equal((await evidence.list('rodion', transaction.id)).length, 1);
    for (const bad of [
      { ...entry, source: 'browser' },
      { ...entry, summary: 'x'.repeat(2001) },
      { ...entry, reference: '' },
    ]) {
      await assert.rejects(
        evidence.add('rodion', transaction.id, 1, bad as typeof entry),
        /invalid_correspondence/,
      );
    }
  } finally {
    await db.close();
  }
});
test('Gmail helper uses exact money and Riga date window without injecting operators or scraping', () => {
  const result = gmailEvidenceSearch({
    ...input,
    id: 'synthetic',
    description: 'Shop" OR in:anywhere {"',
  });
  assert.equal(result.amount, '150.10');
  assert.equal(
    result.query,
    'after:2026/08/25 before:2026/09/09 {"150.10" "150,10"}',
  );
  assert.ok(result.url.startsWith('https://mail.google.com/mail/u/0/#search/'));
  assert.ok(!result.contextQuery!.includes('in:anywhere'));
  assert.equal(
    gmailEvidenceSearch({
      ...input,
      id: 'synthetic',
      currency: 'JPY',
      amountMinor: '-1',
    }).amount,
    '1',
  );
  assert.equal(
    gmailEvidenceSearch({
      ...input,
      id: 'synthetic',
      currency: 'KWD',
      amountMinor: '-1',
    }).amount,
    '0.001',
  );
  assert.throws(
    () => gmailEvidenceSearch({ ...input, id: 'synthetic', currency: 'XXX' }),
    /unsupported_search_amount/,
  );
  const otherDetails = {
    id: 'another',
    fields: [{ label: 'Recipient', value: 'Different owner' }],
    counterpartyAvailable: true,
    cardReferenceAvailable: false,
  };
  assert.ok(
    !gmailEvidenceSearch(
      { ...input, id: 'synthetic' },
      otherDetails,
    ).contextQuery!.includes('Different owner'),
  );
});
