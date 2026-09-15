import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectTransactionDetails,
  transactionDetails,
} from '../src/transaction-details.js';
import { memoryDatabase, migrate } from '../src/database.js';
import { Repository } from '../src/repository.js';
const base = {
  id: 'synthetic',
  source: 'monobank',
  amount_minor: '-16219',
  currency: 'UAH',
  status: 'booked',
  description: 'Synthetic transfer',
  account_label: 'Personal',
};
const values = (row: Parameters<typeof projectTransactionDetails>[0]) =>
  Object.fromEntries(
    projectTransactionDetails(row).fields.map((f) => [f.label, f.value]),
  );
test('Mono details allowlist bank context, mask reference, preserve exact original amount and omit arbitrary secrets', () => {
  const result = projectTransactionDetails({
    ...base,
    source_details: {
      counterName: 'Synthetic recipient',
      counterIban: 'UA123456789012345678901234567',
      comment: 'Synthetic purpose',
      mcc: 5812,
      operationAmount: -350,
      currencyCode: 978,
      commissionRate: 0,
      token: 'DO_NOT_EXPOSE',
      counterEdrpou: 'DO_NOT_EXPOSE',
      maskedPan: ['DO_NOT_EXPOSE'],
      extra: { password: 'DO_NOT_EXPOSE' },
    },
  });
  const fields = Object.fromEntries(
    result.fields.map((f) => [f.label, f.value]),
  );
  assert.equal(fields.Recipient, 'Synthetic recipient');
  assert.equal(fields['Recipient IBAN (masked)'], 'UA12 •••• 4567');
  assert.equal(fields['Original purchase amount'], '−3.50 EUR');
  assert.equal(fields['Bank fee'], '0.00 UAH');
  assert.equal(
    fields['Merchant category code (MCC)'],
    '5812 · Eating places and restaurants',
  );
  assert.equal(result.cardReferenceAvailable, false);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPOSE'), false);
  assert.equal(
    JSON.stringify(result).includes('UA123456789012345678901234567'),
    false,
  );
});
test('Enable Banking selects the other party by direction, never owner or ultimate beneficiary', () => {
  const source_details = {
    creditor: { name: 'Recipient' },
    debtor: { name: 'Sender' },
    ultimate_creditor: { name: 'DO_NOT_EXPOSE' },
    creditor_account: { iban: 'DE12345678901234567890' },
    debtor_account: { iban: 'FR12345678901234567890' },
    merchant_category_code: '5812',
    remittance_information: ['Payment', { token: 'DO_NOT_EXPOSE' }],
    creditor_account_additional_identification: [
      { scheme_name: 'PAN', identification: '4444******1234' },
    ],
  };
  const outgoing = { ...base, source: 'enablebanking', source_details };
  assert.equal(values(outgoing).Recipient, 'Recipient');
  assert.equal(values(outgoing).Sender, undefined);
  assert.equal(
    values(outgoing)['Recipient card (bank-masked)'],
    '4444******1234',
  );
  assert.equal(
    projectTransactionDetails(outgoing).cardReferenceAvailable,
    true,
  );
  const incoming = values({ ...outgoing, amount_minor: '500' });
  assert.equal(incoming.Sender, 'Sender');
  assert.equal(incoming.Recipient, undefined);
  assert.equal(incoming['Sender IBAN (masked)'], 'FR12 •••• 7890');
  assert.equal(incoming['Recipient card (bank-masked)'], undefined);
  assert.equal(
    JSON.stringify(projectTransactionDetails(outgoing)).includes(
      'DO_NOT_EXPOSE',
    ),
    false,
  );
});
test('unknown, malformed and absent context is omitted and full card numbers are never projected', () => {
  const absent = projectTransactionDetails({ ...base, source_details: null });
  assert.equal(absent.counterpartyAvailable, false);
  assert.equal(absent.cardReferenceAvailable, false);
  const malformed = projectTransactionDetails({
    ...base,
    source: 'enablebanking',
    source_details: {
      creditor: { name: { token: 'DO_NOT_EXPOSE' } },
      creditor_account: { iban: 'DO_NOT_EXPOSE' },
      creditor_account_additional_identification: [
        { scheme_name: 'PAN', identification: '4444333322221111' },
      ],
      merchant_category_code: 'DO_NOT_EXPOSE',
      booking_date: 'not a date',
    },
  });
  assert.equal(malformed.counterpartyAvailable, false);
  assert.equal(JSON.stringify(malformed).includes('4444333322221111'), false);
  assert.equal(JSON.stringify(malformed).includes('DO_NOT_EXPOSE'), false);
  assert.equal(
    values({
      ...base,
      amount_minor: '0',
      source: 'enablebanking',
      source_details: {
        creditor: { name: 'Owner' },
        debtor: { name: 'Other' },
      },
    }).Counterparty,
    undefined,
  );
  assert.equal(
    values({
      ...base,
      source: 'synthetic',
      source_details: { counterName: 'Not a provider field' },
    }).Recipient,
    undefined,
  );
});
test('detail read is owner scoped, handles nonexistent/invalid IDs, and never returns source payload', async () => {
  const db = memoryDatabase();
  try {
    await migrate(db);
    const repo = new Repository(db);
    await repo.importBatch([
      {
        source: 'monobank',
        sourceId: 'synthetic',
        accountId: 'synthetic',
        owner: 'rodion',
        bookedAt: '2026-09-12T10:00:00Z',
        currency: 'UAH',
        amountMinor: '-123',
        description: 'Synthetic merchant',
        sourceDetails: { comment: 'Purpose', apiKey: 'DO_NOT_EXPOSE' },
      },
    ]);
    const row = (await repo.list('rodion'))[0]!;
    assert.equal(await transactionDetails(db, 'katya', row.id), null);
    assert.equal(await transactionDetails(db, 'rodion', 'bad-id'), null);
    assert.equal(
      await transactionDetails(
        db,
        'rodion',
        '00000000-0000-0000-0000-000000000000',
      ),
      null,
    );
    const result = await transactionDetails(db, 'rodion', row.id);
    assert.equal(result?.id, row.id);
    assert.equal(JSON.stringify(result).includes('DO_NOT_EXPOSE'), false);
    assert.equal(JSON.stringify(result).includes('source_details'), false);
  } finally {
    await db.close();
  }
});

test('recipient bank uses counterparty IBAN only and card-network evidence remains separate', () => {
  const account = '322001' + '0000000000000000001';
  const check = 98n - (BigInt(account + '301000') % 97n);
  const iban = 'UA' + check.toString().padStart(2, '0') + account;
  const fields = values({
    ...base,
    source_details: { mcc: 4829, counterIban: iban },
  });
  assert.equal(fields['Recipient bank'], 'АТ "УНІВЕРСАЛ БАНК"');
  assert.match(fields['Bank identification source']!, /Counterparty IBAN/);
  assert.equal(fields['Recipient card network'], undefined);
  const missing = values({
    ...base,
    source_details: { mcc: 4829, iban, maskedPan: ['444444******1234'] },
  });
  assert.match(missing['Recipient bank']!, /Not supplied/);
  assert.equal(missing['Recipient card network'], undefined);
  const eb = values({
    ...base,
    source: 'enablebanking',
    source_details: {
      creditor_agent: { name: 'Synthetic recipient bank' },
      debtor_agent: { name: 'Wrong owner bank' },
      creditor_account_additional_identification: [
        { scheme_name: 'PAN', identification: '555555******1234' },
      ],
    },
  });
  assert.equal(eb['Recipient bank'], 'Synthetic recipient bank');
  assert.equal(eb['Recipient card network'], 'Mastercard');
});
