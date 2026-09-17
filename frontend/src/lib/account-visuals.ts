/**
 * The one place that decides how an account looks. Every bank has exactly one
 * glyph, every card product exactly one tile, every household member one
 * colour and initial, so an account badge anywhere in the app is drawn from
 * this data and never from an icon picked ad hoc.
 *
 * Colours are named here and defined in src/index.css (the `--account-*`
 * tokens), as frontend/DESIGN.md requires. Artwork is SVG path data in a 24×24
 * box: Revolut and Wise are their published marks (Simple Icons, CC0); the
 * Monobank cat and the Swedbank oak are silhouettes drawn for this registry,
 * bold enough to survive a 20 px tile.
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
    // Cat head filling the box: tall ears, round face, two eye holes cut with
    // the even-odd rule. Big shapes only, so it still reads at 14 px.
    path:
      'M3.5 2.2 9 6.1A8.5 8.5 0 0 1 15 6.1L20.5 2.2 20.4 12.5A8.5 8.5 0 1 1 3.6 12.5Z' +
      'M7.3 13.6a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0Z' +
      'M12.9 13.6a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0Z',
    fillRule: 'evenodd',
  },
  swedbank: {
    // Oak after the bank's coin emblem: a three-lobed crown on a flared trunk.
    // The rounds and the trunk all run clockwise so they union under nonzero.
    path:
      'M4.5 9a7.5 7.5 0 1 0 15 0 7.5 7.5 0 1 0-15 0Z' +
      'M1.7 12a4.8 4.8 0 1 0 9.6 0 4.8 4.8 0 1 0-9.6 0Z' +
      'M12.7 12a4.8 4.8 0 1 0 9.6 0 4.8 4.8 0 1 0-9.6 0Z' +
      'M9.9 14.5H14.1V19.6L16.4 22H7.6L9.9 19.6Z',
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
  /** A `var(--account-*)` token from index.css. */
  fill: string;
  /** Colour of the glyph drawn on the tile, also a token. */
  ink: string;
  /** Hairline for tiles too light to stand on a card surface. */
  border?: string;
  name: string;
};

const ink = 'var(--account-ink)';
/** Near-black tiles vanish on the dark card surface; this hairline is
 * transparent in light mode and a faint edge in dark mode. */
const edge = 'var(--account-edge)';

/**
 * Monobank tells its cards apart by colour, so the products do too: same cat,
 * different tile. The other banks keep their own brand colour.
 */
export const tiles: Record<Bank | 'unknown', Partial<Record<Product, Tile>>> = {
  monobank: {
    iron: { fill: 'var(--account-mono-iron)', ink, name: 'Mono Iron' },
    black: {
      fill: 'var(--account-mono-black)',
      ink,
      border: edge,
      name: 'Mono Black',
    },
    white: {
      fill: 'var(--account-mono-white)',
      ink: 'var(--account-ink-dark)',
      border: 'var(--border)',
      name: 'Mono White',
    },
    aid: { fill: 'var(--account-mono-aid)', ink, name: 'Mono Aid' },
    'national-cashback': {
      fill: 'var(--account-mono-cashback)',
      ink: 'var(--account-mono-cashback-ink)',
      name: 'Mono NC',
    },
    fop: { fill: 'var(--account-mono-fop)', ink, name: 'Mono FOP' },
    standard: {
      fill: 'var(--account-mono-black)',
      ink,
      border: edge,
      name: 'Monobank',
    },
  },
  swedbank: {
    standard: { fill: 'var(--account-swedbank)', ink, name: 'Swedbank' },
  },
  revolut: {
    standard: {
      fill: 'var(--account-revolut)',
      ink,
      border: edge,
      name: 'Revolut',
    },
  },
  wise: {
    standard: {
      fill: 'var(--account-wise)',
      ink: 'var(--account-wise-ink)',
      name: 'Wise',
    },
  },
  cash: {
    standard: {
      fill: 'var(--account-cash)',
      ink: 'var(--account-cash-ink)',
      name: 'Cash',
    },
  },
  unknown: {
    standard: { fill: 'var(--chart-5)', ink, name: 'Account' },
  },
};

export function tileFor(bank: Bank | null, product: Product): Tile {
  const family = tiles[bank ?? 'unknown'];
  return family[product] ?? family.standard ?? tiles.unknown.standard!;
}

/** Household members take two of the chart series, so they follow the theme. */
export const owners: Record<
  Owner,
  { name: string; initial: string; color: string }
> = {
  rodion: { name: 'Rodion', initial: 'R', color: 'var(--chart-1)' },
  katya: { name: 'Katya', initial: 'K', color: 'var(--chart-3)' },
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
  if (/кешб|кэшб|cashback|нацкеш|\bnc\b/.test(text)) return 'national-cashback';
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
      glyph: { x: 4, y: 4, scale: 16 / 24 },
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
    glyph: { x: tile.x + 5, y: tile.y + 5, scale: 22 / 24 },
    ring: null,
    disc,
    pill,
  };
}
