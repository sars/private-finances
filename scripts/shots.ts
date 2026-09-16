// Renders app routes at phone and desktop width so a change can be looked at
// before it ships. Writes PNGs to .shots/ (ignored by Git).
//
//   pnpm demo                      in another shell, on http://127.0.0.1:3300
//   pnpm shots                     home, transactions and analytics, light
//   pnpm shots /fx /categories     chosen routes
//   SHOTS_DARK=1 pnpm shots        add dark mode
//
// A phone shot costs roughly 440 tokens to look at and a desktop shot 1,400, so
// take them once per finished screen, not after every edit.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.SHOTS_BASE ?? 'http://127.0.0.1:3300';
const requested = process.argv.slice(2);
const routes = requested.length ? requested : ['/', '/review', '/analytics'];
const schemes: Array<'light' | 'dark'> = process.env.SHOTS_DARK
  ? ['light', 'dark']
  : ['light'];
// Desktop first: the demo import button sits in the desktop layout.
const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
];
const out = '.shots';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const colorScheme of schemes) {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport,
        colorScheme,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      // A screen that crashes renders the error boundary, which looks fine in
      // a screenshot; the exception itself is what tells you why.
      page.on('pageerror', (error) =>
        console.error(`page error on ${page.url()}: ${error.message}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error')
          console.error(`console error on ${page.url()}: ${message.text()}`);
      });
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      // A demo server starts empty; import the synthetic examples once.
      const importButton = page.getByRole('button', {
        name: 'Import example transactions',
      });
      if (await importButton.count()) {
        await importButton.first().click();
        await page.waitForTimeout(1500);
      }
      for (const route of routes) {
        await page.goto(base + route, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        const name =
          route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-');
        const file = `${out}/${name}-${viewport.name}-${colorScheme}.png`;
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
