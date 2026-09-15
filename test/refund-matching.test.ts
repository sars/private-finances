import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeAmounts,
  incomingCounterparty,
  originalAmount,
  refundCandidates,
  refundDecision,
  type RefundRow,
} from '../src/refund-matching.js';

const base: RefundRow = {
  id: '00000000-0000-4000-8000-000000000001',
  source: 'monobank',
  accountId: 'card-uah',
  owner: 'rodion',
  bookedAt: '2026-08-03T10:00:00Z',
  currency: 'UAH',
  amountMinor: '-93639',
  description: 'EPIDEMIC SOUND',
  status: 'booked',
  kind: 'personal_expense',
  category: 'Apps & services',
  sourceDetails: { amount: -93639, operationAmount: -1799, currencyCode: 978 },
};
const row = (over: Partial<RefundRow>): RefundRow => ({ ...base, ...over });
const credit = row({
  id: '00000000-0000-4000-8000-000000000002',
  bookedAt: '2026-09-13T10:00:00Z',
  amountMinor: '92885',
  kind: 'unresolved',
  category: null,
  sourceDetails: { amount: 92885, operationAmount: 1799, currencyCode: 978 },
});

test('the original amount is what the merchant charged, not the ledger amount', () => {
  assert.deepEqual(originalAmount(base), {
    amountMinor: '-1799',
    currency: 'EUR',
  });
  assert.deepEqual(originalAmount(credit), {
    amountMinor: '1799',
    currency: 'EUR',
  });
  // Without a recorded conversion the ledger amount is the original amount.
  assert.deepEqual(originalAmount(row({ sourceDetails: {} })), {
    amountMinor: '-93639',
    currency: 'UAH',
  });
  // A stale detail block that no longer describes the stored amount is ignored.
  assert.deepEqual(
    originalAmount(
      row({
        sourceDetails: {
          amount: -1,
          operationAmount: -1799,
          currencyCode: 978,
        },
      }),
    ),
    { amountMinor: '-93639', currency: 'UAH' },
  );
  assert.deepEqual(
    originalAmount(
      row({
        source: 'enablebanking',
        amountMinor: '-1799',
        currency: 'EUR',
        sourceDetails: {
          currency_exchange: {
            instructed_amount: { amount: '20.35', currency: 'USD' },
          },
        },
      }),
    ),
    { amountMinor: '-2035', currency: 'USD' },
  );
});

test('a reversal forty-one days later matches on the original amount and links silently', () => {
  const decision = refundDecision(credit, [base]);
  assert.deepEqual(decision, {
    action: 'link',
    debitId: base.id,
    rule: 'exact_original',
    reductionMinor: '92885',
  });
});

test('automatic matching never reaches across accounts or people', () => {
  const otherAccount = row({
    id: '00000000-0000-4000-8000-000000000003',
    accountId: 'katya-card',
    owner: 'katya',
  });
  assert.deepEqual(refundCandidates(credit, [otherAccount]), []);
  assert.deepEqual(refundDecision(credit, [otherAccount]), {
    action: 'none',
    reason: 'no_candidate',
  });
});

test('a partial refund with exactly one larger outstanding charge is linked without asking', () => {
  const charge = row({
    id: '00000000-0000-4000-8000-000000000010',
    description: 'BOLT RIGA',
    amountMinor: '-200',
    sourceDetails: {},
    bookedAt: '2026-09-01T08:00:00Z',
  });
  const partial = row({
    id: '00000000-0000-4000-8000-000000000011',
    description: 'BOLT RIGA',
    amountMinor: '145',
    sourceDetails: {},
    bookedAt: '2026-09-03T08:00:00Z',
    kind: 'unresolved',
    category: null,
  });
  assert.deepEqual(refundDecision(partial, [charge]), {
    action: 'link',
    debitId: charge.id,
    rule: 'single_partial',
    reductionMinor: '145',
  });
  // Already returned in full: nothing is left to reduce.
  assert.deepEqual(
    refundDecision(partial, [{ ...charge, reducedMinor: '200' }]),
    { action: 'none', reason: 'no_candidate' },
  );
});

test('identical charges go to the nearest preceding one, whatever they are filed as', () => {
  const first = row({
    id: '00000000-0000-4000-8000-000000000020',
    description: 'BOLT RIGA',
    amountMinor: '-1000',
    sourceDetails: {},
    bookedAt: '2026-09-01T08:00:00Z',
  });
  const second = { ...first, id: '00000000-0000-4000-8000-000000000021' };
  const reversal = row({
    id: '00000000-0000-4000-8000-000000000022',
    description: 'BOLT RIGA',
    amountMinor: '1000',
    sourceDetails: {},
    bookedAt: '2026-09-02T08:00:00Z',
    kind: 'unresolved',
    category: null,
  });
  // The cancellation belongs to the hold placed most recently before it: a ride
  // hailed and cancelled minutes apart, while the earlier ride is still running.
  assert.deepEqual(refundDecision(reversal, [second, first]), {
    action: 'link',
    debitId: second.id,
    rule: 'indistinguishable_nearest',
    reductionMinor: '1000',
  });
  // How a ride was categorised is a label we chose, not evidence about which
  // one the merchant refunded, so it does not change the answer.
  const different = { ...second, category: 'Transport / Ride-hailing' };
  assert.deepEqual(refundDecision(reversal, [first, different]), {
    action: 'link',
    debitId: different.id,
    rule: 'indistinguishable_nearest',
    reductionMinor: '1000',
  });
});

test('a reversal a cent adrift from its only likely parent is linked to it', () => {
  const charge = row({
    id: '00000000-0000-4000-8000-000000000030',
    description: 'BOLT RIGA',
    amountMinor: '-520',
    sourceDetails: {},
    bookedAt: '2026-09-01T08:00:00Z',
  });
  const smaller = row({
    id: '00000000-0000-4000-8000-000000000031',
    description: 'BOLT RIGA',
    amountMinor: '519',
    sourceDetails: {},
    bookedAt: '2026-09-02T08:00:00Z',
    kind: 'unresolved',
    category: null,
  });
  // One outstanding charge a whisker away, on either side of it.
  assert.equal(refundDecision(smaller, [charge]).action, 'link');
  const larger = { ...smaller, amountMinor: '521' };
  assert.deepEqual(refundDecision(larger, [charge]), {
    action: 'link',
    debitId: charge.id,
    rule: 'nearest_amount',
    reductionMinor: '521',
  });
  // Far enough away, and it is a question again rather than a guess.
  const unrelated = { ...smaller, amountMinor: '640' };
  assert.deepEqual(refundDecision(unrelated, [charge]), {
    action: 'ask',
    reason: 'unclear_amount',
    debitIds: [charge.id],
  });
});

test('money from a person is always asked about; a merchant credit is not', () => {
  const fromPerson = row({
    id: '00000000-0000-4000-8000-000000000040',
    description: 'Vasyl Petrenko',
    amountMinor: '50000',
    kind: 'unresolved',
    category: null,
    sourceDetails: { counterName: 'Vasyl Petrenko', mcc: 4829 },
  });
  assert.deepEqual(refundDecision(fromPerson, []), {
    action: 'ask',
    reason: 'from_person',
    debitIds: [],
  });
  assert.equal(incomingCounterparty(fromPerson), 'person');
  assert.equal(
    incomingCounterparty({
      ...fromPerson,
      sourceDetails: { counterName: 'SIA Rimi Latvia', mcc: 4829 },
    }),
    'merchant',
  );
  assert.equal(
    incomingCounterparty({ ...fromPerson, sourceDetails: { mcc: 5411 } }),
    'merchant',
  );
  assert.deepEqual(
    refundDecision({ ...fromPerson, sourceDetails: { mcc: 5411 } }, []),
    { action: 'none', reason: 'no_candidate' },
  );
});

test('the window bounds how long a refund may follow its charge', () => {
  const charge = row({ sourceDetails: {}, bookedAt: '2026-01-01T00:00:00Z' });
  const late = row({
    id: '00000000-0000-4000-8000-000000000050',
    amountMinor: '93639',
    sourceDetails: {},
    kind: 'unresolved',
    category: null,
    bookedAt: '2026-05-02T00:00:00Z',
  });
  assert.deepEqual(refundCandidates(late, [charge]), []);
  const inside = { ...late, bookedAt: '2026-04-30T00:00:00Z' };
  assert.equal(refundCandidates(inside, [charge]).length, 1);
  // A hold is matched now and recalculated when the bank settles it, which is
  // what the owner asked for: the link exists while the amount is provisional.
  assert.deepEqual(refundDecision({ ...inside, status: 'pending' }, [charge]), {
    action: 'link',
    debitId: charge.id,
    rule: 'exact_original',
    reductionMinor: '93639',
  });
});

test('the reversal that repeats a charge to the kopiyka links to that charge', () => {
  // Two rides at 2.00 EUR on different days are different amounts of hryvnia,
  // and the cancellation repeats the hryvnia of the one it belongs to.
  const earlier = row({
    id: '00000000-0000-4000-8000-000000000060',
    description: 'Bolt',
    bookedAt: '2026-08-27T08:00:00Z',
    amountMinor: '-10468',
    category: 'Transport / Public transport',
    sourceDetails: { amount: -10468, operationAmount: -200, currencyCode: 978 },
  });
  const later = {
    ...earlier,
    id: '00000000-0000-4000-8000-000000000061',
    bookedAt: '2026-08-28T08:00:00Z',
    amountMinor: '-10466',
    sourceDetails: { amount: -10466, operationAmount: -200, currencyCode: 978 },
  };
  const cancellation = row({
    id: '00000000-0000-4000-8000-000000000062',
    description: 'Скасування. Bolt',
    bookedAt: '2026-08-29T08:00:00Z',
    amountMinor: '10466',
    kind: 'unresolved',
    category: null,
    sourceDetails: { amount: 10466, operationAmount: 200, currencyCode: 978 },
  });
  assert.deepEqual(refundDecision(cancellation, [earlier, later]), {
    action: 'link',
    debitId: later.id,
    rule: 'exact_ledger_and_original',
    reductionMinor: '10466',
  });
  // Without that exact repeat, the two rides are the same 2.00 EUR ride as far
  // as anything in the data can tell, so the nearer one takes it.
  const adrift = {
    ...cancellation,
    amountMinor: '10467',
    sourceDetails: { amount: 10467, operationAmount: 200, currencyCode: 978 },
  };
  assert.deepEqual(refundDecision(adrift, [earlier, later]), {
    action: 'link',
    debitId: later.id,
    rule: 'indistinguishable_nearest',
    reductionMinor: '10467',
  });
  // A charge already returned in full is not a candidate at all, so the only
  // outstanding one is matched on its own terms.
  assert.deepEqual(
    refundDecision(cancellation, [
      { ...earlier, amountMinor: '-10466', reducedMinor: '10466' },
      later,
    ]),
    {
      action: 'link',
      debitId: later.id,
      rule: 'exact_original',
      reductionMinor: '10466',
    },
  );
});

test('a charge already reversed in full is not a rival, even with rate residue', () => {
  // The owner's Playtomic bookings. A 14.74 EUR booking on 10 April was
  // cancelled and returned in full, but the hryvnia rate had moved, so 8.93 UAH
  // of the charge was left unreduced. That residue kept a spent booking in the
  // running against every later 14.74 cancellation, and because its reductions
  // differed it made the candidates look like a set nobody could tell apart —
  // so three real cancellations became questions instead of links.
  const booking = (
    id: string,
    date: string,
    ledger: string,
    reduced?: string,
  ) =>
    row({
      id,
      description: 'Playtomic',
      bookedAt: `${date}T09:00:00Z`,
      amountMinor: ledger,
      reducedMinor: reduced,
      sourceDetails: {
        amount: Number(ledger),
        operationAmount: -1474,
        currencyCode: 978,
      },
    });
  const spent = booking(
    '00000000-0000-4000-8000-0000000000a1',
    '2026-04-10',
    '-75543',
    '74650',
  );
  const outstanding = booking(
    '00000000-0000-4000-8000-0000000000a2',
    '2026-05-09',
    '-76751',
  );
  const cancellation = row({
    id: '00000000-0000-4000-8000-0000000000a3',
    description: 'Скасування. Playtomic',
    bookedAt: '2026-05-13T22:42:00Z',
    amountMinor: '76090',
    kind: 'unresolved',
    category: null,
    sourceDetails: { amount: 76090, operationAmount: 1474, currencyCode: 978 },
  });
  assert.deepEqual(
    refundCandidates(cancellation, [spent, outstanding]).map((m) => m.debit.id),
    [outstanding.id],
  );
  assert.deepEqual(refundDecision(cancellation, [spent, outstanding]), {
    action: 'link',
    debitId: outstanding.id,
    rule: 'exact_original',
    reductionMinor: '76090',
  });
  // A charge with room left over is still a candidate: the filter is about what
  // a purchase can still give back, not about having been touched. A 32.00 EUR
  // booking half returned can still return another 14.74.
  const partly = row({
    id: '00000000-0000-4000-8000-0000000000a4',
    description: 'Playtomic',
    bookedAt: '2026-05-10T09:00:00Z',
    amountMinor: '-160000',
    reducedMinor: '76000',
    sourceDetails: {
      amount: -160000,
      operationAmount: -3200,
      currencyCode: 978,
    },
  });
  assert.equal(refundCandidates(cancellation, [partly]).length, 1);
  // Half of it again, and there is nothing left for a third reversal to be.
  assert.equal(
    refundCandidates(cancellation, [{ ...partly, reducedMinor: '152000' }])
      .length,
    0,
  );
});

test('a reversal a whisker from exactly one outstanding charge belongs to it', () => {
  // Bolt charges a ride at 5.20 EUR and returns 5.19: the app rounds, the ride
  // is the same one. Every other ride that month is further away than that.
  const ride = (id: string, day: string, original: number, ledger: string) =>
    row({
      id,
      description: 'Bolt',
      bookedAt: `2026-08-${day}T08:00:00Z`,
      amountMinor: ledger,
      category: 'Transport / Public transport',
      sourceDetails: {
        amount: Number(ledger),
        operationAmount: original,
        currencyCode: 978,
      },
    });
  const charged = ride(
    '00000000-0000-4000-8000-000000000070',
    '29',
    -520,
    '-27149',
  );
  const others = [
    ride('00000000-0000-4000-8000-000000000071', '28', -530, '-27736'),
    ride('00000000-0000-4000-8000-000000000072', '28', -490, '-25642'),
  ];
  const cancellation = row({
    id: '00000000-0000-4000-8000-000000000073',
    description: 'Скасування. Bolt',
    bookedAt: '2026-08-29T20:00:00Z',
    amountMinor: '27212',
    kind: 'unresolved',
    category: null,
    sourceDetails: { amount: 27212, operationAmount: 519, currencyCode: 978 },
  });
  assert.deepEqual(refundDecision(cancellation, [charged, ...others]), {
    action: 'link',
    debitId: charged.id,
    rule: 'nearest_amount',
    reductionMinor: '27212',
  });
  // Two candidates equally close but not the same amount is a real question.
  const nearlyTwin = {
    ...charged,
    id: '00000000-0000-4000-8000-000000000074',
    amountMinor: '-27150',
    sourceDetails: {
      amount: -27150,
      operationAmount: -518,
      currencyCode: 978,
    },
  };
  assert.equal(
    refundDecision(cancellation, [charged, nearlyTwin, ...others]).action,
    'ask',
  );
  // A genuine partial refund is nowhere near its parent and is not absorbed.
  const partial = {
    ...cancellation,
    amountMinor: '10000',
    sourceDetails: { amount: 10000, operationAmount: 191, currencyCode: 978 },
  };
  const decision = refundDecision(partial, [charged, ...others]);
  assert.notEqual(
    decision.action === 'link' ? decision.rule : null,
    'nearest_amount',
  );
});

test('closeAmounts is a whisker, not a tolerance band', () => {
  assert.equal(closeAmounts(520n, 519n), true);
  assert.equal(closeAmounts(1000n, 991n), true);
  assert.equal(closeAmounts(1000n, 989n), false);
  assert.equal(closeAmounts(100n, 97n), true);
  assert.equal(closeAmounts(100n, 96n), false);
});

test('a partial refund goes to the latest charge that can absorb it', () => {
  // A cancelled rail ticket returns part of what was paid, and several tickets
  // could absorb it. All filed the same way, so which one shrinks changes no
  // total; it follows the purchase it most likely cancels.
  const ticket = (id: string, day: string, ledger: string, category: string) =>
    row({
      id,
      description: 'Укрзалізниця',
      bookedAt: `2026-06-${day}T08:00:00Z`,
      amountMinor: ledger,
      category,
      sourceDetails: {},
    });
  const older = ticket(
    '00000000-0000-4000-8000-000000000080',
    '18',
    '-60000',
    'Transport / Rail',
  );
  const newer = ticket(
    '00000000-0000-4000-8000-000000000081',
    '21',
    '-50000',
    'Transport / Rail',
  );
  const refund = row({
    id: '00000000-0000-4000-8000-000000000082',
    description: 'Скасування. Укрзалізниця',
    bookedAt: '2026-06-23T08:00:00Z',
    amountMinor: '18802',
    kind: 'unresolved',
    category: null,
    sourceDetails: {},
  });
  assert.deepEqual(refundDecision(refund, [older, newer]), {
    action: 'link',
    debitId: newer.id,
    rule: 'partial_latest',
    reductionMinor: '18802',
  });
  // Filed differently changes nothing: the same ticket office refunded it.
  const otherCategory = { ...newer, category: 'Travel / Trips' };
  assert.deepEqual(refundDecision(refund, [older, otherCategory]), {
    action: 'link',
    debitId: otherCategory.id,
    rule: 'partial_latest',
    reductionMinor: '18802',
  });
});

test('a name that merely contains the merchant is not that merchant', () => {
  // Bolt and Bolt Food are different services and the bank writes each exactly.
  const ride = row({
    id: '00000000-0000-4000-8000-000000000090',
    description: 'Bolt',
    bookedAt: '2026-08-01T08:00:00Z',
    amountMinor: '-52340',
    sourceDetails: {
      amount: -52340,
      operationAmount: -1000,
      currencyCode: 978,
    },
  });
  const meal = {
    ...ride,
    id: '00000000-0000-4000-8000-000000000091',
    description: 'Bolt Food',
    bookedAt: '2026-08-02T08:00:00Z',
  };
  const refund = row({
    id: '00000000-0000-4000-8000-000000000092',
    description: 'Скасування. Bolt Food',
    bookedAt: '2026-08-03T08:00:00Z',
    amountMinor: '52340',
    kind: 'unresolved',
    category: null,
    sourceDetails: { amount: 52340, operationAmount: 1000, currencyCode: 978 },
  });
  assert.deepEqual(refundDecision(refund, [ride, meal]), {
    action: 'link',
    debitId: meal.id,
    rule: 'exact_original',
    reductionMinor: '52340',
  });
  // With no exact name to prefer, the near name is still a candidate.
  assert.equal(refundDecision(refund, [ride]).action, 'link');
});

test('a cancelled hold goes to the ride hailed the same minute', () => {
  // April receipts: no ride on 22 April, so the 2.01 that came back cancels the
  // 2.02 hold placed that minute — not the 2.00 hold from two days earlier that
  // happens to be a cent away too.
  const ride = (id: string, day: string, time: string, original: number) =>
    row({
      id,
      description: 'Bolt',
      bookedAt: `2026-04-${day}T${time}:00Z`,
      amountMinor: String(original * -52),
      sourceDetails: {
        amount: original * -52,
        operationAmount: -original,
        currencyCode: 978,
      },
    });
  const earlier = ride(
    '00000000-0000-4000-8000-000000000100',
    '20',
    '15:26',
    200,
  );
  const sameMinute = ride(
    '00000000-0000-4000-8000-000000000101',
    '21',
    '22:47',
    202,
  );
  const cancellation = row({
    id: '00000000-0000-4000-8000-000000000102',
    description: 'Скасування. Bolt',
    bookedAt: '2026-04-21T22:47:00Z',
    amountMinor: '10571',
    kind: 'unresolved',
    category: null,
    sourceDetails: { amount: 10571, operationAmount: 201, currencyCode: 978 },
  });
  assert.deepEqual(refundDecision(cancellation, [earlier, sameMinute]), {
    action: 'link',
    debitId: sameMinute.id,
    rule: 'nearest_amount',
    reductionMinor: '10571',
  });
  // Two candidates the same amount apart and at the same moment: a question.
  const twin = { ...sameMinute, id: '00000000-0000-4000-8000-000000000103' };
  assert.equal(refundDecision(cancellation, [sameMinute, twin]).action, 'ask');
});
