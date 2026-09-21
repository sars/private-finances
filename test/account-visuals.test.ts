import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test('no screen writes a member name into itself', () => {
  // The demo workspace renames the household so a screenshot can be published,
  // and the rename works by rewriting `owners` in place — so it reaches a
  // screen only if that screen asked. Nine did not: they carried their own
  // `'Rodion'`/`'Katya'` ternary, and one wrote `'Kate'`, a spelling nothing
  // else used. The result was a Bank imports row reading avatar "A" beside the
  // label "Rodion", the household's own name on a page built to be published.
  //
  // This is a grep rather than a render test on purpose. The fault was never
  // that one screen was wrong; it was that nothing stopped the next screen
  // from writing the name again, and only a rule about the source can.
  const sources = execFileSync('git', ['ls-files', 'frontend/src', 'src'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => /\.(ts|tsx)$/.test(path))
    .filter((path) => !path.endsWith('.test.ts'));

  // The three places a member's name is allowed to be written down: the map
  // the frontend rewrites, the one the server rewrites, and Telegram's own —
  // which addresses a person rather than labelling a screen, and which demo
  // mode never loads at all.
  const allowed = new Set([
    'frontend/src/lib/account-visuals.ts',
    'src/account-names.ts',
    'src/telegram.ts',
  ]);

  const offenders: string[] = [];
  for (const path of sources) {
    if (allowed.has(path)) continue;
    const text = readFileSync(
      new URL(`../../${path}`, import.meta.url),
      'utf8',
    );
    for (const [index, line] of text.split('\n').entries()) {
      // Only string literals count. A comment explaining the rule, or an
      // owner key like `rodion`, is not a name on a screen.
      if (/['"`](Rodion|Katya|Kate)['"`]/.test(line.replace(/\/\/.*$/, '')))
        offenders.push(`${path}:${index + 1}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these write a member name instead of reading it from `owners` or ' +
      '`ownerNames()`, so the demo cannot rename them:\n' +
      offenders.join('\n'),
  );
});
