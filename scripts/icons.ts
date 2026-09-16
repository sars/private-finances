// Renders frontend/public/icon.svg to the PNG sizes the web-app manifest needs.
// Run after changing the icon: node scripts/icons.ts
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const svg = readFileSync('frontend/public/icon.svg', 'utf8');
const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace(
        /width="512" height="512"/,
        `width="${size}" height="${size}"`,
      )}</body></html>`,
    );
    await page.screenshot({
      path: `frontend/public/icon-${size}.png`,
      omitBackground: true,
    });
    console.log(`frontend/public/icon-${size}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
