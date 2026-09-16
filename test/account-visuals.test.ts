import test from 'node:test';
import assert from 'node:assert/strict';
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

test('every bank has a glyph and every card a tile, so no account can render unstyled', () => {
  for (const bank of [...banks, 'unknown'] as const) {
    assert.ok(glyphs[bank]?.path.length > 20, `${bank} glyph`);
    assert.match(glyphs[bank].path, /^M/);
    for (const product of products) {
      const tile = tileFor(bank === 'unknown' ? null : bank, product);
      assert.ok(tile.name, `${bank} ${product} tile`);
      assert.match(
        Array.isArray(tile.fill) ? tile.fill[0] : tile.fill,
        /^#[0-9a-f]{6}$/,
      );
    }
  }
  // Every Monobank card the household holds is a distinct tile.
  const monoFills = Object.values(
    tiles.monobank as Record<string, { fill: unknown }>,
  ).map((t) => JSON.stringify(t.fill));
  assert.equal(new Set(monoFills).size, monoFills.length - 1); // 'standard' reuses black
  for (const owner of ['rodion', 'katya'] as const) {
    assert.equal(owners[owner].initial.length, 1);
    assert.match(owners[owner].color, /^#[0-9a-f]{6}$/);
  }
});

test("the household's nine accounts resolve from the names the owner gives them", () => {
  const cases: Array<[string, string, string, string]> = [
    ['monobank', 'Mono Iron', 'monobank', 'iron'],
    ['monobank', 'Mono Black', 'monobank', 'black'],
    ['monobank', 'Mono White', 'monobank', 'white'],
    ['monobank', 'Mono Aid', 'monobank', 'aid'],
    ['monobank', 'Mono нацкешбек', 'monobank', 'national-cashback'],
    ['monobank', 'Mono FOP', 'monobank', 'fop'],
    ['monobank', 'Моно ФОП USD', 'monobank', 'fop'],
    ['enablebanking', 'Swedbank', 'swedbank', 'standard'],
    ['enablebanking', 'Revolut USD', 'revolut', 'standard'],
    ['enablebanking', 'Wise EUR', 'wise', 'standard'],
    ['manual_cash', '', 'cash', 'standard'],
  ];
  for (const [source, label, bank, product] of cases) {
    const resolved = bankFor(source, label);
    assert.equal(resolved, bank, label);
    assert.equal(productFor(resolved, label), product, label);
  }
  assert.equal(bankFor('enablebanking', ''), null);
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
        if (g.pill) {
          assert.ok(g.pill.x + g.pill.width <= w, `${size} pill right`);
          assert.ok(g.pill.y + g.pill.height <= h, `${size} pill bottom`);
        }
        if (g.disc)
          assert.ok(g.disc.cx - g.disc.r >= 0 && g.disc.cy - g.disc.r >= 0);
        if (size === 'sm') assert.equal(g.pill, null);
      }
});
