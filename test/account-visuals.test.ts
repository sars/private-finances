import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const visuals = await import(
  new URL('../../frontend/src/lib/account-visuals.ts', import.meta.url).href
);
const {
  badgeGeometry,
  bankFor,
  banks,
  currencyFromLabel,
  glyphs,
  owners,
  productFor,
  products,
  tileFor,
  tiles,
} = visuals;
const tokensCss = readFileSync(
  new URL('../../frontend/src/index.css', import.meta.url),
  'utf8',
);
const TOKEN = /^var\(--([a-z0-9-]+)\)$/;
function definedToken(value: string, where: string) {
  const match = TOKEN.exec(value);
  assert.ok(match, `${where}: ${value} is not a var(--token)`);
  assert.ok(
    tokensCss.includes(`--${match![1]}:`),
    `${where}: --${match![1]} is not defined in index.css`,
  );
}

test('every bank has a glyph and every card a tile, and every colour is a token from index.css', () => {
  for (const bank of [...banks, 'unknown'] as const) {
    assert.ok(glyphs[bank]?.path.length > 20, `${bank} glyph`);
    assert.match(glyphs[bank].path, /^M/);
    for (const product of products) {
      const tile = tileFor(bank === 'unknown' ? null : bank, product);
      assert.ok(tile.name, `${bank} ${product} tile`);
      definedToken(tile.fill, `${bank} ${product} fill`);
      definedToken(tile.ink, `${bank} ${product} ink`);
      if (tile.border) definedToken(tile.border, `${bank} ${product} border`);
    }
  }
  // Every Monobank card the household holds is a distinct tile.
  const monoFills = Object.values(
    tiles.monobank as Record<string, { fill: string }>,
  ).map((t) => t.fill);
  assert.equal(new Set(monoFills).size, monoFills.length - 1); // 'standard' reuses black
  for (const owner of ['rodion', 'katya'] as const) {
    assert.equal(owners[owner].initial.length, 1);
    definedToken(owners[owner].color, `${owner} colour`);
  }
  // The registry names colours; it never holds one (frontend/DESIGN.md).
  const source = readFileSync(
    new URL('../../frontend/src/lib/account-visuals.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /#[0-9a-f]{3,6}\b/i);
});

test("the household's accounts resolve from the names the owner gives them", () => {
  const cases: Array<[string, string, string, string]> = [
    ['monobank', 'Mono Iron', 'monobank', 'iron'],
    ['monobank', 'Mono Black', 'monobank', 'black'],
    ['monobank', 'Mono White', 'monobank', 'white'],
    ['monobank', 'Mono Aid', 'monobank', 'aid'],
    ['monobank', 'Mono NC', 'monobank', 'national-cashback'],
    ['monobank', 'Mono National cashback', 'monobank', 'national-cashback'],
    ['monobank', 'Mono нацкешбек', 'monobank', 'national-cashback'],
    ['monobank', 'Mono FOP', 'monobank', 'fop'],
    ['monobank', 'Моно ФОП USD', 'monobank', 'fop'],
    ['enablebanking', 'Swedbank', 'swedbank', 'standard'],
    ['enablebanking', 'Revolut USD', 'revolut', 'standard'],
    ['enablebanking', 'Wise EUR', 'wise', 'standard'],
    ['enablebanking', 'LHV EUR', 'lhv', 'standard'],
    ['manual_cash', '', 'cash', 'standard'],
  ];
  for (const [source, label, bank, product] of cases) {
    const resolved = bankFor(source, label);
    assert.equal(resolved, bank, label);
    assert.equal(productFor(resolved, label), product, label);
  }
  assert.equal(bankFor('enablebanking', ''), null);
  assert.equal(tileFor('monobank', 'national-cashback').name, 'Mono NC');
  assert.equal(currencyFromLabel('Wise EUR'), 'EUR');
  assert.equal(currencyFromLabel('Revolut usd'), 'USD');
  assert.equal(currencyFromLabel('Mono Black'), null);
});

test('the badge keeps its parts inside the picture at every size', () => {
  for (const size of ['sm', 'md', 'lg'] as const)
    for (const owner of [true, false])
      for (const currency of [null, 'UAH', 'USD']) {
        const g = badgeGeometry(size, { owner, currency });
        const [, , w, h] = g.viewBox.split(' ').map(Number);
        assert.ok(g.tile.x >= 0 && g.tile.y >= 0);
        assert.ok(g.tile.x + g.tile.size <= w && g.tile.y + g.tile.size <= h);
        // The glyph's 24-unit box, scaled, stays inside the tile.
        assert.ok(
          g.glyph.x + 24 * g.glyph.scale <= g.tile.x + g.tile.size + 0.01,
        );
        if (g.pill) {
          assert.ok(g.pill.x + g.pill.width <= w, `${size} pill right`);
          assert.ok(g.pill.y + g.pill.height <= h, `${size} pill bottom`);
        }
        if (g.disc)
          assert.ok(g.disc.cx - g.disc.r >= 0 && g.disc.cy - g.disc.r >= 0);
        if (size === 'sm') assert.equal(g.pill, null);
      }
});
