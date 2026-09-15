import {
  recipientBankFromIban,
  recipientCardNetwork,
} from './recipient-bank.js';
import { displayMcc, readMcc } from './mcc.js';
import type { Executor, Row } from './database.js';
import type { Owner } from './domain.js';

type Field = { label: string; value: string };
/**
 * The few bank facts that help a person recognise a payment, named rather than
 * formatted into a label/value list. The review page shows these in its own
 * layout; `fields` stays the flat record for the collapsed raw view.
 */
export type DetailSummary = {
  originalAmount: string | null;
  purpose: string | null;
  mcc: { code: string; meaning: string; note: string } | null;
  counterparty: {
    role: string;
    name: string | null;
    iban: string | null;
    card: string | null;
    cardNetwork: string | null;
    bank: string | null;
    bankSource: string | null;
  };
  cashback: string | null;
  bankTransactionType: string | null;
  valueDate: string | null;
};
export type TransactionDetails = {
  id: string;
  fields: Field[];
  summary: DetailSummary;
  counterpartyAvailable: boolean;
  cardReferenceAvailable: boolean;
};
const record = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown, max = 2000): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
const codes: Record<number, string> = {
  980: 'UAH',
  978: 'EUR',
  840: 'USD',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  752: 'SEK',
  578: 'NOK',
  208: 'DKK',
  392: 'JPY',
  414: 'KWD',
  48: 'BHD',
};
const exponents: Record<string, number> = { JPY: 0, KWD: 3, BHD: 3 };
function money(value: unknown, currency: string): string | undefined {
  if (typeof value !== 'string' || !/^-?\d{1,40}$/.test(value)) return;
  const negative = value.startsWith('-');
  const exponent = exponents[currency] ?? 2;
  const digits = value.replace(/^-/, '').padStart(exponent + 1, '0');
  return `${negative ? '−' : ''}${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits} ${currency}`;
}
function iban(value: unknown): string | undefined {
  const v = text(value, 100)?.replace(/\s/g, '').toUpperCase();
  return v && /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)
    ? `${v.slice(0, 4)} •••• ${v.slice(-4)}`
    : undefined;
}
function maskedCard(value: unknown): string | undefined {
  const v = text(value, 40);
  // Never expose a full PAN or reinterpret an arbitrary account reference as a card.
  return v &&
    /^[\d*Xx• -]{8,30}$/.test(v) &&
    /[*Xx•]{2}/.test(v) &&
    /\d{4}$/.test(v)
    ? v
    : undefined;
}
/** Active reductions, as the details panel shows them beside the bank amount. */
export type RefundDetail = {
  role: 'reduced' | 'refund';
  peerBookedAt: string;
  reductionMinor: string;
  origin: string;
};
/** Provider data is untrusted. Only documented, explicitly selected fields leave this boundary. */
export function projectTransactionDetails(
  row: Row,
  refunds: RefundDetail[] = [],
): TransactionDetails {
  const fields: Field[] = [];
  const add = (label: string, value: unknown) => {
    const v = text(value);
    if (v) fields.push({ label, value: v });
  };
  const d = record(row.source_details);
  const amount = String(row.amount_minor);
  const direction =
    /^-\d+$/.test(amount) && BigInt(amount) < 0n
      ? 'outgoing'
      : /^\d+$/.test(amount) && BigInt(amount) > 0n
        ? 'incoming'
        : 'neutral';
  const partyLabel =
    direction === 'outgoing'
      ? 'Recipient'
      : direction === 'incoming'
        ? 'Sender'
        : 'Counterparty';
  add('Account amount', money(amount, String(row.currency)));
  add(
    'Direction',
    direction === 'outgoing'
      ? 'Money out'
      : direction === 'incoming'
        ? 'Money in'
        : 'Zero amount',
  );
  // The bank the owner recognises, never the integration that fetched the row.
  // Monobank is both, so it can be named; an aggregated account is identified
  // by the name the owner gave it, which is the Account field below.
  add(
    row.source === 'manual_cash' ? 'Payment method' : 'Bank',
    row.source === 'manual_cash'
      ? 'Cash · entered by you'
      : row.source === 'monobank'
        ? 'Monobank'
        : row.source === 'enablebanking'
          ? undefined
          : 'Imported statement',
  );
  add('Account', row.account_label);
  add('Status', row.status === 'pending' ? 'Pending' : 'Booked');
  add('Description', row.description);
  const bookedAt =
    row.booked_at instanceof Date
      ? row.booked_at.toISOString()
      : text(row.booked_at);
  if (bookedAt && Number.isFinite(Date.parse(bookedAt)))
    add(
      row.source === 'manual_cash'
        ? 'Purchase date (day only)'
        : row.source === 'enablebanking'
          ? 'Statement date'
          : 'Transaction time (UTC)',
      row.source === 'manual_cash'
        ? String(d.purchaseDate ?? bookedAt.slice(0, 10))
        : row.source === 'enablebanking'
          ? bookedAt.slice(0, 10)
          : new Date(bookedAt).toISOString(),
    );
  let party: string | undefined;
  let account: string | undefined;
  let card: string | undefined;
  let bank: string | undefined;
  let bankSource: string | undefined;
  let counterpartyIban: unknown;
  let purpose: string | undefined;
  let originalAmount: string | undefined;
  let cashback: string | undefined;
  let bankTransactionType: string | undefined;
  let valueDate: string | undefined;
  if (row.source === 'monobank') {
    party = text(d.counterName);
    account = iban(d.counterIban);
    counterpartyIban = d.counterIban;
    purpose = text(d.comment);
    add('Comment / payment purpose', d.comment);
    add('Merchant category code (MCC)', displayMcc(d));
    const currency = codes[Number(d.currencyCode)];
    if (currency && Number.isSafeInteger(d.operationAmount)) {
      const original = money(String(d.operationAmount), currency);
      add('Original purchase amount', original);
      // In the formatted view it only tells a person something when it is not
      // the account amount repeated in the account's own currency.
      if (currency !== String(row.currency)) originalAmount = original;
    }
    if (Number.isSafeInteger(d.commissionRate))
      add('Bank fee', money(String(d.commissionRate), String(row.currency)));
    if (
      Number.isSafeInteger(d.cashbackAmount) &&
      Number(d.cashbackAmount) !== 0
    ) {
      cashback = money(String(d.cashbackAmount), String(row.currency));
      add('Cashback', cashback);
    }
  } else if (row.source === 'enablebanking') {
    // A credit's counterparty is the debtor; showing creditor would show the owner's own account.
    const side =
      direction === 'outgoing'
        ? 'creditor'
        : direction === 'incoming'
          ? 'debtor'
          : undefined;
    if (side) {
      party = text(record(d[side]).name);
      counterpartyIban = record(d[`${side}_account`]).iban;
      account = iban(counterpartyIban);
      bank = text(record(d[`${side}_agent`]).name);
      if (bank) bankSource = 'Bank-provided counterparty institution';
      const extra = d[`${side}_account_additional_identification`];
      if (Array.isArray(extra)) {
        for (const raw of extra.slice(0, 10)) {
          const ref = record(raw);
          if (ref.scheme_name === 'PAN')
            card = maskedCard(ref.identification) ?? card;
        }
      }
    }
    add('Merchant category code (MCC)', displayMcc(d));
    if (Array.isArray(d.remittance_information))
      purpose = text(
        d.remittance_information
          .filter((v) => typeof v === 'string')
          .slice(0, 20)
          .join('\n'),
      );
    add('Payment purpose', purpose);
    bankTransactionType = text(record(d.bank_transaction_code).description);
    add('Bank transaction type', bankTransactionType);
    purpose = purpose ?? text(d.note);
    add('Note', d.note);
    for (const [label, key] of [
      ['Booking date', 'booking_date'],
      ['Value date', 'value_date'],
    ] as const) {
      const date = text(d[key]);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (key === 'value_date') valueDate = date;
        add(label, date);
      }
    }
  }
  // A refund reduces what the purchase cost; both the bank amount and the result
  // are shown, because the net figure appears on no statement (ADR 0007).
  const reductions = refunds.filter((item) => item.role === 'reduced');
  if (reductions.length) {
    const returned = reductions.reduce(
      (total, item) => total + BigInt(item.reductionMinor),
      0n,
    );
    add('Money returned', money(returned.toString(), String(row.currency)));
    const net = BigInt(amount) + returned;
    add(
      'Cost after refunds',
      money((net > 0n ? 0n : net).toString(), String(row.currency)),
    );
    for (const item of reductions)
      add(
        `Refund received ${item.peerBookedAt.slice(0, 10)}`,
        `${money(item.reductionMinor, String(row.currency))} · ${
          item.origin === 'automatic'
            ? 'matched automatically'
            : 'confirmed by owner'
        }`,
      );
  }
  for (const item of refunds.filter((r) => r.role === 'refund'))
    add(
      'Refund of a purchase',
      `${money(item.reductionMinor, String(row.currency))} returned against a purchase of ${item.peerBookedAt.slice(0, 10)}`,
    );
  if (!bank) {
    const inferred = recipientBankFromIban(counterpartyIban);
    if (inferred?.bankName) {
      bank = inferred.bankName;
      bankSource =
        'Counterparty IBAN bank code · NBU registry ' +
        inferred.registryRetrievedAt;
    } else if (inferred) {
      bank = 'Unknown bank · code ' + inferred.bankCode;
      bankSource = 'Counterparty IBAN bank code';
    }
  }
  add(`${partyLabel} bank`, bank);
  add('Bank identification source', bankSource);
  if (!bank && (readMcc(d)?.financialTransfer || account))
    add(
      `${partyLabel} bank`,
      row.source === 'monobank'
        ? 'Not supplied by the Monobank personal API. The Monobank app may show additional details.'
        : 'Not supplied in the imported bank statement.',
    );
  const cardNetwork = recipientCardNetwork(card);
  add(`${partyLabel} card network`, cardNetwork);
  add(partyLabel, party);
  add(`${partyLabel} IBAN (masked)`, account);
  add(`${partyLabel} card (bank-masked)`, card);
  const mcc = readMcc(d);
  return {
    id: String(row.id),
    fields,
    summary: {
      originalAmount: originalAmount ?? null,
      purpose: purpose ?? null,
      mcc: mcc
        ? {
            code: String(mcc.code).padStart(4, '0'),
            meaning: mcc.meaning,
            note: mcc.inferenceNote,
          }
        : null,
      counterparty: {
        role: partyLabel,
        name: party ?? null,
        iban: account ?? null,
        card: card ?? null,
        cardNetwork: cardNetwork ?? null,
        bank: bank ?? null,
        bankSource: bankSource ?? null,
      },
      cashback: cashback ?? null,
      bankTransactionType: bankTransactionType ?? null,
      valueDate: valueDate ?? null,
    },
    counterpartyAvailable: Boolean(party || account || card),
    cardReferenceAvailable: Boolean(card),
  };
}
export async function transactionDetails(
  db: Executor,
  actor: Owner,
  id: string,
): Promise<TransactionDetails | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    return null;
  const row = (
    await db.query(
      `SELECT t.id,t.source,t.amount_minor,t.currency,t.status,t.description,t.booked_at,t.source_details,a.label AS account_label
    FROM transactions t LEFT JOIN own_accounts a ON a.source=t.source AND a.account_id=t.account_id AND a.owner=t.owner
    WHERE t.id=$1 AND t.owner=$2`,
      [id, actor],
    )
  ).rows[0];
  if (!row) return null;
  const links = (
    await db.query(
      `SELECT r.debit_id,r.reduction_minor,r.origin,c.booked_at AS credit_booked_at,d.booked_at AS debit_booked_at
       FROM refund_links r JOIN transactions d ON d.id=r.debit_id JOIN transactions c ON c.id=r.credit_id
       WHERE r.state='active' AND (r.debit_id=$1 OR r.credit_id=$1) ORDER BY c.booked_at,r.id`,
      [id],
    )
  ).rows;
  const time = (value: unknown) =>
    (value instanceof Date ? value : new Date(String(value))).toISOString();
  return projectTransactionDetails(
    row,
    links.map((link) => {
      const reduced = String(link.debit_id) === id;
      return {
        role: reduced ? ('reduced' as const) : ('refund' as const),
        peerBookedAt: time(
          reduced ? link.credit_booked_at : link.debit_booked_at,
        ),
        reductionMinor: String(link.reduction_minor),
        origin: String(link.origin),
      };
    }),
  );
}
