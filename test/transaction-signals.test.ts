import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTransactionSignals } from '../src/transaction-signals.js';

const base = { amountMinor: '-100', status: 'booked', sourceDetails: {} };
const inspect = (description: string) =>
  inspectTransactionSignals({ ...base, description });

test('explicit English, Ukrainian and Russian phone top-ups yield private, interpretable signals', () => {
  for (const description of [
    'Mobile top-up',
    'PHONE TOP UP',
    'Top up my phone',
    'Refill on my phone number',
    'Phone number recharge',
    'Поповнення мобільного',
    'Поповнення телефону',
    'Поповнення рахунку оператора',
    'Поповнити свій телефон',
    'Пополнение мобильного',
    'Пополнение телефона',
    'пополнить номер телефона',
    'ＭＯＢＩＬＥ top-up',
    'Поповнення мобільного +380000000000',
  ]) {
    const result = inspect(description);
    assert.equal(result.clearPhoneTopUp, true, description);
    assert.equal(result.uncertainty, null);
    assert.deepEqual(result.evidence, [
      'explicit_phone_top_up_description',
      'booked_outflow',
    ]);
    assert.equal(JSON.stringify(result).includes('380000000000'), false);
  }
});

test('card, wallet, account and operator names alone never become phone spending', () => {
  for (const description of [
    'Bank card top up',
    'Mobile wallet recharge',
    'Phone card topup',
    'Поповнення картки',
    'Поповнення банківського рахунку',
    'Поповнення рахунку',
    'Пополнение кошелька',
    'Kyivstar',
    'Vodafone',
    'lifecell',
    'Telephone bill',
    'Mobile phone purchase',
    'Phone case and refill',
    'Phone and petrol refill',
    'Card top-up from mobile phone',
    'Revolut phone refill',
    'Mobile app account top up',
    'Telephony topup',
    'Mobile topupnot',
  ])
    assert.equal(inspect(description).clearPhoneTopUp, false, description);
});

test('refunds, work costs, mixed spending and explicit negation remain ambiguous', () => {
  for (const description of [
    'Phone topup refund',
    'Phone recharge for business',
    'Company mobile topup',
    'Phone refill reimbursement',
    'Mixed mobile topup',
    'Phone recharge split',
    'Not a phone topup',
    'No phone refill',
    'Поповнення телефону повернення',
    'Пополнение мобильного компенсация',
    'Поповнення корпоративного телефону',
    'Phone recharge failed',
    'Cancelled mobile top-up',
  ]) {
    const result = inspect(description);
    assert.equal(result.clearPhoneTopUp, false, description);
    assert.equal(result.uncertainty, 'exceptional_or_nonpersonal_context');
  }
});

test('only active negative integer amounts qualify, without floating-point conversion', () => {
  for (const amountMinor of [
    '0',
    '-0',
    '100',
    '1.5',
    'NaN',
    '',
    '-1e3',
    '-1.0',
  ]) {
    assert.equal(
      inspectTransactionSignals({
        ...base,
        description: 'Phone refill',
        amountMinor,
      }).clearPhoneTopUp,
      false,
    );
  }
  for (const status of ['reversed', 'unknown']) {
    assert.equal(
      inspectTransactionSignals({
        ...base,
        description: 'Phone refill',
        status,
      }).clearPhoneTopUp,
      false,
    );
  }
  assert.equal(
    inspectTransactionSignals({
      ...base,
      description: 'Phone refill',
      amountMinor: '-999999999999999999999999',
    }).clearPhoneTopUp,
    true,
  );
});

test('MCC is weak metadata corroboration, never a classification or a guessed nested field', () => {
  const input = {
    ...base,
    description: 'Telecom merchant',
    sourceDetails: { mcc: 4814 },
  };
  assert.deepEqual(inspectTransactionSignals(input), {
    clearPhoneTopUp: false,
    evidence: ['telecommunications_mcc'],
    uncertainty: 'no_explicit_phone_top_up',
    mcc: 4814,
  });
  assert.deepEqual(
    inspectTransactionSignals({ ...input, description: 'Phone refill' })
      .evidence,
    [
      'telecommunications_mcc',
      'explicit_phone_top_up_description',
      'booked_outflow',
    ],
  );
  for (const mcc of ['4814', null, {}, 4814.5, Infinity, -4814, 99999]) {
    assert.equal(
      inspectTransactionSignals({ ...input, sourceDetails: { mcc } }).mcc,
      null,
    );
  }
  assert.equal(
    inspectTransactionSignals({
      ...input,
      sourceDetails: { raw: { mcc: 4814 } },
    }).mcc,
    null,
  );
});

test('long descriptions fail closed without ignoring a contradictory suffix; inputs remain unchanged', () => {
  const input = {
    ...base,
    description: `Phone topup ${' '.repeat(4000)} refund`,
    sourceDetails: { mcc: 4814 },
  };
  const before = structuredClone(input);
  assert.equal(
    inspectTransactionSignals(input).uncertainty,
    'description_too_long',
  );
  assert.deepEqual(input, before);
});

test('bank processing does not make an explicit purpose uncertain', () => {
  const signal = inspectTransactionSignals({
    ...base,
    status: 'pending',
    description: 'Phone refill',
  });
  assert.equal(signal.clearPhoneTopUp, true);
  assert.deepEqual(signal.evidence, [
    'explicit_phone_top_up_description',
    'pending_outflow',
  ]);
});
