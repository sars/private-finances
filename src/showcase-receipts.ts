/**
 * The five receipts the article can open.
 *
 * A receipt is a photograph and a reading of it, and the two have to agree: a
 * picture of one shop beside an extraction naming another would be the first
 * thing a reader noticed. So both come from this one list — the generator
 * script draws the photographs from it, and the seeder writes the readings
 * from it.
 *
 * Nothing here is a real receipt. `scripts/make-receipt-images.mjs` renders
 * them with Playwright, which the project already carries for screenshots, so
 * no photograph of the household's own shopping is ever committed.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Database } from './database.js';

export type ShowcaseReceiptItem = { name: string; minor: number };
export type ShowcaseReceipt = {
  /** File under `showcase/receipts/`, written by the generator script. */
  file: string;
  merchant: string;
  currency: string;
  owner: 'rodion' | 'katya';
  /** How long before the seeding day this was bought. */
  daysAgo: number;
  /** Where the payment it belongs to is placed in the tree. */
  category: string;
  items: readonly ShowcaseReceiptItem[];
};

export const SHOWCASE_RECEIPTS: readonly ShowcaseReceipt[] = [
  {
    file: 'silpo.jpg',
    merchant: 'Silpo',
    currency: 'UAH',
    owner: 'rodion',
    daysAgo: 2,
    category: 'food.groceries',
    items: [
      { name: 'Bread, rye', minor: 4200 },
      { name: 'Milk 2.5%, 1 l', minor: 5600 },
      { name: 'Chicken fillet, 0.9 kg', minor: 24300 },
      { name: 'Tomatoes, 0.6 kg', minor: 9800 },
      { name: 'Coffee beans, 250 g', minor: 31900 },
    ],
  },
  {
    file: 'atb.jpg',
    merchant: 'ATB',
    currency: 'UAH',
    owner: 'katya',
    daysAgo: 4,
    category: 'food.groceries',
    items: [
      { name: 'Apples, 1.2 kg', minor: 7400 },
      { name: 'Yoghurt, 4 pcs', minor: 8800 },
      { name: 'Pasta, 500 g', minor: 3900 },
      { name: 'Olive oil, 500 ml', minor: 21500 },
    ],
  },
  {
    file: 'wog.jpg',
    merchant: 'WOG',
    currency: 'UAH',
    owner: 'rodion',
    daysAgo: 6,
    category: 'transport.car.fuel',
    items: [
      { name: 'Petrol A95, 28.4 l', minor: 146300 },
      { name: 'Coffee, large', minor: 5500 },
    ],
  },
  {
    file: 'apteka.jpg',
    merchant: 'Apteka ANC',
    currency: 'UAH',
    owner: 'katya',
    daysAgo: 9,
    category: 'health.pharmacy',
    items: [
      { name: 'Vitamin D3, 60 caps', minor: 18700 },
      { name: 'Throat spray', minor: 12400 },
    ],
  },
  {
    file: 'epicentr.jpg',
    merchant: 'Epicentr',
    currency: 'UAH',
    owner: 'rodion',
    daysAgo: 13,
    category: 'home.goods',
    items: [
      { name: 'LED bulbs, 4 pcs', minor: 27600 },
      { name: 'Extension lead, 3 m', minor: 19900 },
      { name: 'Picture hooks', minor: 6300 },
    ],
  },
];

/** What the till added up to, which is what the payment has to say too. */
export function receiptTotalMinor(receipt: ShowcaseReceipt): number {
  return receipt.items.reduce((total, item) => total + item.minor, 0);
}

const money = (minor: number): string => (minor / 100).toFixed(2);

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

/**
 * The receipt as a page, for the generator to photograph.
 *
 * Deliberately plain: a till slip is monospaced, narrow and grey, and a
 * prettier one would look like a designed invoice rather than something
 * somebody photographed on a kitchen table.
 */
export function receiptHtml(receipt: ShowcaseReceipt, date: string): string {
  const lines = receipt.items
    .map(
      (item) =>
        `<tr><td>${escape(item.name)}</td>` +
        `<td class="a">${money(item.minor)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#8d8f8a;display:flex;justify-content:center;
      padding:34px 0;font-family:"DejaVu Sans Mono",monospace}
    .slip{background:#f7f6f1;width:320px;padding:22px 20px 30px;color:#20211f;
      box-shadow:0 10px 28px rgba(0,0,0,.35);font-size:13px;line-height:1.55}
    h1{font-size:17px;letter-spacing:.14em;text-align:center;margin:0 0 4px}
    .sub{text-align:center;font-size:11px;color:#55564f;margin-bottom:16px}
    table{width:100%;border-collapse:collapse}
    td{padding:3px 0;vertical-align:top}
    .a{text-align:right;white-space:nowrap;padding-left:10px}
    .rule{border-top:1px dashed #9a9b93;margin:12px 0}
    .total{display:flex;justify-content:space-between;font-size:15px;
      font-weight:bold;letter-spacing:.04em}
    .foot{text-align:center;font-size:10px;color:#6a6b63;margin-top:18px;
      letter-spacing:.09em}
  </style></head><body><div class="slip">
    <h1>${escape(receipt.merchant.toUpperCase())}</h1>
    <div class="sub">${escape(date)} &nbsp;·&nbsp; TERMINAL 04</div>
    <table>${lines}</table>
    <div class="rule"></div>
    <div class="total"><span>TOTAL</span>
      <span>${money(receiptTotalMinor(receipt))} ${escape(receipt.currency)}</span></div>
    <div class="rule"></div>
    <div class="foot">THANK YOU · PLEASE KEEP THIS RECEIPT</div>
  </div></body></html>`;
}

/** The account each member's shopping is paid from, in the invented household. */
export const RECEIPT_ACCOUNTS: Record<string, string> = {
  rodion: 'mono-alex-black',
  katya: 'mono-sam-white',
};

/** The identifier the payment for a receipt is imported under. */
export const receiptSourceId = (receipt: ShowcaseReceipt): string =>
  `showcase-receipt-${receipt.file.replace(/\.[a-z]+$/, '')}`;

/**
 * Attach the photographed slips to the payments they belong to.
 *
 * A receipt the application holds is a picture plus a reading of it, matched
 * to a payment — so all three are written here from the same list, and the
 * figure on the slip is the figure on the payment.
 *
 * If the pictures have not been drawn yet the receipts are simply skipped:
 * `scripts/make-receipt-images.mjs` needs Playwright, which the server does
 * not have, so a seeded workspace must not depend on them existing.
 */
export async function seedShowcaseReceipts(
  db: Database,
  now: Date,
): Promise<{ attached: number; missing: number }> {
  let attached = 0;
  let missing = 0;
  for (const [index, receipt] of SHOWCASE_RECEIPTS.entries()) {
    let image: Buffer;
    try {
      image = await readFile(
        new URL(`../../showcase/receipts/${receipt.file}`, import.meta.url),
      );
    } catch {
      missing += 1;
      continue;
    }
    const payment = (
      await db.query<{ id: string }>(
        'SELECT id FROM transactions WHERE source=$1 AND source_id=$2',
        ['showcase', receiptSourceId(receipt)],
      )
    ).rows[0];
    if (!payment) {
      missing += 1;
      continue;
    }
    const bought = new Date(now.getTime() - receipt.daysAgo * 86400000);
    const extraction = {
      isReceipt: true,
      merchant: receipt.merchant,
      date: bought.toISOString().slice(0, 10),
      amountMinor: String(-receiptTotalMinor(receipt)),
      currency: receipt.currency,
      items: receipt.items.map(
        (item) => `${item.name} — ${(item.minor / 100).toFixed(2)}`,
      ),
    };
    await db.query(
      `INSERT INTO receipt_jobs
         (id,owner,chat_id,message_id,file_id,state,image,mime,extraction,
          transaction_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,'matched',$6,'image/jpeg',$7,$8,$9,$9)`,
      [
        randomUUID(),
        receipt.owner,
        'showcase',
        1000 + index,
        `showcase-${receipt.file}`,
        image,
        JSON.stringify(extraction),
        payment.id,
        bought.toISOString(),
      ],
    );
    attached += 1;
  }
  return { attached, missing };
}
