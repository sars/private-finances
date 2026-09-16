/**
 * The one place that decides how an account looks. Every bank has exactly one
 * glyph, every card product exactly one tile colour, every household member one
 * colour and initial, so an account badge anywhere in the app is drawn from
 * this data and never from an icon picked ad hoc. All artwork is SVG path data
 * in a 24×24 box: Revolut and Wise are their published marks (Simple Icons,
 * CC0); the Monobank cat and the Swedbank oak are simplified silhouettes drawn
 * for this registry so that all four read as one family.
 */
export type Bank = 'monobank' | 'swedbank' | 'revolut' | 'wise' | 'cash';
export type Product =
  'iron' | 'black' | 'white' | 'aid' | 'national-cashback' | 'fop' | 'standard';
export type Owner = 'rodion' | 'katya';

export const banks: Bank[] = [
  'monobank',
  'swedbank',
  'revolut',
  'wise',
  'cash',
];
export const products: Product[] = [
  'iron',
  'black',
  'white',
  'aid',
  'national-cashback',
  'fop',
  'standard',
];

export type Glyph = {
  /** SVG path data in a 24×24 box, filled with the tile's ink colour. */
  path: string;
  fillRule: 'nonzero' | 'evenodd';
};

export const glyphs: Record<Bank | 'unknown', Glyph> = {
  monobank: {
    // Cat head: two ears, round face, eye holes cut with the even-odd rule.
    path:
      'M4.8 3.4 9.4 7.6A7.6 7.6 0 0 1 14.6 7.6L19.2 3.4 19 11.6A7.4 7.4 0 1 1 5 11.6Z' +
      'M9.1 14.2a1.15 1.15 0 1 0 2.3 0 1.15 1.15 0 1 0-2.3 0Z' +
      'M12.6 14.2a1.15 1.15 0 1 0 2.3 0 1.15 1.15 0 1 0-2.3 0Z',
    fillRule: 'evenodd',
  },
  swedbank: {
    // Oak: a bushy canopy of overlapping rounds on a short flared trunk, after
    // the bank's coin emblem. Same-direction circles union under the nonzero rule.
    path:
      'M7.5 7.5a4.5 4.5 0 1 0 9 0 4.5 4.5 0 1 0-9 0Z' +
      'M3.6 10.4a3.9 3.9 0 1 0 7.8 0 3.9 3.9 0 1 0-7.8 0Z' +
      'M12.6 10.4a3.9 3.9 0 1 0 7.8 0 3.9 3.9 0 1 0-7.8 0Z' +
      'M3 14.3a3.4 3.4 0 1 0 6.8 0 3.4 3.4 0 1 0-6.8 0Z' +
      'M14.2 14.3a3.4 3.4 0 1 0 6.8 0 3.4 3.4 0 1 0-6.8 0Z' +
      'M7.6 12.6a4.4 4.4 0 1 0 8.8 0 4.4 4.4 0 1 0-8.8 0Z' +
      'M7.2 16.4a2.9 2.9 0 1 0 5.8 0 2.9 2.9 0 1 0-5.8 0Z' +
      'M11 16.4a2.9 2.9 0 1 0 5.8 0 2.9 2.9 0 1 0-5.8 0Z' +
      'M10.7 14.5h2.6v5.4l1.3 1.6H9.4l1.3-1.6Z',
    fillRule: 'nonzero',
  },
  revolut: {
    path: 'M20.9133 6.9566C20.9133 3.1208 17.7898 0 13.9503 0H2.424v3.8605h10.9782c1.7376 0 3.177 1.3651 3.2087 3.043 .016 .84 -.2994 1.633-.8878 2.2324-.5886.5998-1.375.9303-2.2144.9303H9.2322a.2756.2756 0 0 0-.2755.2752v3.431c0 .0585 .018 .1142 .052 .1612L16.2646 24h5.3114l-7.2727-10.094c3.6625-.1838 6.61-3.2612 6.61-6.9494zM6.8943 5.9229H2.424V24h4.4704z',
    fillRule: 'nonzero',
  },
  wise: {
    path: 'M6.488 7.469 0 15.05h11.585l1.301-3.576H7.922l3.033-3.507.01-.092L8.993 4.48h8.873l-6.878 18.925h4.706L24 .595H2.543l3.945 6.874Z',
    fillRule: 'nonzero',
  },
  cash: {
    // A banknote: outer sheet, inner margin cut out, a coin left in the middle.
    path: 'M1.5 5.5h21v13h-21Z M3.5 7.5v9h17v-9Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5Z',
    fillRule: 'evenodd',
  },
  unknown: {
    // A plain bank building for an account whose bank the label does not say.
    path: 'M12 2.5 21 7.5H3Z M4.5 9h2.5v7H4.5Z M9 9h2.5v7H9Z M12.5 9H15v7h-2.5Z M17 9h2.5v7H17Z M3 17.5h18v3H3Z',
    fillRule: 'nonzero',
  },
};

export type Tile = {
  /** Solid fill, or two stops for a metallic top-to-bottom gradient. */
  fill: string | [string, string];
  /** Colour of the glyph drawn on the tile. */
  ink: string;
  /** Hairline for tiles too light to stand on a white card. */
  border?: string;
  name: string;
};

/**
 * Monobank tells its cards apart by colour, so the products do too: same cat,
 * different tile. The other banks keep their own brand colour.
 */
export const tiles: Record<Bank | 'unknown', Partial<Record<Product, Tile>>> = {
  monobank: {
    iron: { fill: ['#5b6069', '#23262b'], ink: '#ffffff', name: 'Mono Iron' },
    black: { fill: '#111315', ink: '#ffffff', name: 'Mono Black' },
    white: {
      fill: '#ffffff',
      ink: '#15181b',
      border: '#c9ced4',
      name: 'Mono White',
    },
    aid: { fill: '#a8232e', ink: '#ffffff', name: 'Mono Aid' },
    'national-cashback': {
      fill: '#0f4c9c',
      ink: '#ffd54a',
      name: 'Mono Нацкешбек',
    },
    fop: { fill: '#0e6b6b', ink: '#ffffff', name: 'Mono ФОП' },
    standard: { fill: '#111315', ink: '#ffffff', name: 'Monobank' },
  },
  swedbank: {
    standard: { fill: '#ff5f00', ink: '#ffffff', name: 'Swedbank' },
  },
  revolut: {
    standard: { fill: '#191c1f', ink: '#ffffff', name: 'Revolut' },
  },
  wise: {
    standard: { fill: '#9fe870', ink: '#163300', name: 'Wise' },
  },
  cash: {
    standard: { fill: '#f1b82d', ink: '#3b2a06', name: 'Cash' },
  },
  unknown: {
    standard: { fill: '#64748b', ink: '#ffffff', name: 'Account' },
  },
};

export function tileFor(bank: Bank | null, product: Product): Tile {
  const family = tiles[bank ?? 'unknown'];
  return family[product] ?? family.standard ?? tiles.unknown.standard!;
}

export const owners: Record<
  Owner,
  { name: string; initial: string; color: string }
> = {
  rodion: { name: 'Rodion', initial: 'R', color: '#4f5bd5' },
  katya: { name: 'Katya', initial: 'K', color: '#d0487a' },
};

/** Which bank an account is with, read from the connector and the owner's own name for it. */
export function bankFor(
  source: string | undefined,
  label: string,
): Bank | null {
  const text = label.toLocaleLowerCase();
  if (source === 'manual_cash') return 'cash';
  if (/revolut|револют/.test(text)) return 'revolut';
  if (/\bwise\b|вайз/.test(text)) return 'wise';
  if (/swedbank|сведбанк/.test(text)) return 'swedbank';
  if (source === 'monobank' || /\bmono/.test(text)) return 'monobank';
  return null;
}

/** Which card, for banks that issue several; everything else is the standard tile. */
export function productFor(bank: Bank | null, label: string): Product {
  if (bank !== 'monobank') return 'standard';
  const text = label.toLocaleLowerCase();
  if (/\biron|айрон|залізн/.test(text)) return 'iron';
  if (/\bblack|чорн|черн/.test(text)) return 'black';
  if (/\bwhite|біл|бел/.test(text)) return 'white';
  if (/\baid\b|допомог|помощ/.test(text)) return 'aid';
  if (/кешб|кэшб|cashback|нацкеш/.test(text)) return 'national-cashback';
  if (/\bfop\b|фоп|business|бізнес/.test(text)) return 'fop';
  return 'standard';
}

/** The ISO currency the owner wrote into an account's name, if any. */
export function currencyFromLabel(
  label: string | null | undefined,
): string | null {
  const match = /\b(UAH|USD|EUR|GBP|PLN|SEK|CHF|CZK|NOK|DKK)\b/i.exec(
    label ?? '',
  );
  return match ? match[1].toUpperCase() : null;
}

export type BadgeSize = 'sm' | 'md' | 'lg';

/**
 * Where everything sits inside the badge's SVG, so the React component and any
 * preview draw the same picture. Units are SVG user units; the tile is always
 * 32 wide in the full layout and 22 in the small one, and the badge scales to
 * its rendered height.
 */
export function badgeGeometry(
  size: BadgeSize,
  parts: { owner: boolean; currency: string | null },
) {
  if (size === 'sm') {
    return {
      height: 20,
      viewBox: '0 0 24 24',
      tile: { x: 1, y: 1, size: 22, radius: 6 },
      glyph: { x: 5, y: 5, scale: 14 / 24 },
      ring: parts.owner ? { width: 2 } : null,
      disc: null,
      pill: null,
    };
  }
  const tile = {
    x: parts.owner ? 8 : 2,
    y: parts.owner ? 8 : 2,
    size: 32,
    radius: 9,
  };
  const disc = parts.owner
    ? { cx: tile.x, cy: tile.y, r: 7, fontSize: 8.5 }
    : null;
  const currency = parts.currency;
  const pill = currency
    ? {
        width: 9 + 6.4 * currency.length,
        height: 12.5,
        x: tile.x + tile.size - 4 - (9 + 6.4 * currency.length) / 2,
        y: tile.y + tile.size - 8,
        radius: 6.25,
        fontSize: 8.5,
      }
    : null;
  const right = pill ? pill.x + pill.width : tile.x + tile.size;
  const bottom = pill ? pill.y + pill.height : tile.y + tile.size;
  const width = right + 2;
  const heightUnits = bottom + 2;
  return {
    height: size === 'lg' ? 58 : 38,
    viewBox: `0 0 ${width} ${heightUnits}`,
    aspect: width / heightUnits,
    tile,
    glyph: { x: tile.x + 6, y: tile.y + 6, scale: 20 / 24 },
    ring: null,
    disc,
    pill,
  };
}
