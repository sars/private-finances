// Draws the five showcase receipts and writes them to showcase/receipts/.
//
//   pnpm build && node scripts/make-receipt-images.mjs
//
// Run once and commit the result. They are photographs of till slips that do
// not exist, rendered with the Playwright the project already carries for
// screenshots — so no picture of the household's own shopping is ever
// committed, and the seeder has something to attach to a payment.
//
// The content comes from src/showcase-receipts.ts, which the seeder also
// reads, so the picture and the reading of it cannot drift apart.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SHOWCASE_RECEIPTS,
  receiptHtml,
} from '../dist/src/showcase-receipts.js';

const out = 'showcase/receipts';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
try {
  // A phone-ish portrait frame, so the result looks photographed rather than
  // exported.
  const context = await browser.newContext({
    viewport: { width: 420, height: 720 },
    deviceScaleFactor: 2,
  });
  for (const receipt of SHOWCASE_RECEIPTS) {
    const page = await context.newPage();
    // A fixed date, so re-running never rewrites a committed picture. The
    // seeder dates the payment relative to today; the slip is a prop.
    await page.setContent(receiptHtml(receipt, '14/09/2026 18:42'), {
      waitUntil: 'load',
    });
    const image = await page.screenshot({ type: 'jpeg', quality: 82 });
    await writeFile(`${out}/${receipt.file}`, image);
    await page.close();
    console.log(`${out}/${receipt.file} (${image.length} bytes)`);
  }
} finally {
  await browser.close();
}
