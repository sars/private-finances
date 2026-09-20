/**
 * A household that does not exist, for screenshots.
 *
 * The application is shown in a public article, so every figure, merchant and
 * person in these pages has to be invented. Masking the real ones was the
 * cheaper idea and the wrong one: a screenshot is permanent, a screencast is
 * not reviewed frame by frame, and an article full of blanked-out numbers
 * shows nothing worth looking at. Inventing the data instead means there is no
 * real figure anywhere in the workspace to escape.
 *
 * What stays real is the part that discloses nothing and would be tedious to
 * fake: the category tree, the banks (the repository is public and already
 * names every integration), the currencies, the dates and the interface. What
 * is invented is every amount, every description, and both members.
 *
 * The household is generated from a fixed seed, so re-running this produces
 * the same people with the same spending. Screenshots taken a month apart
 * agree with each other, and a figure quoted in the article's text still
 * matches the picture beside it.
 */
import { randomUUID } from 'node:crypto';
import { isMemoryDatabase, type Database } from './database.js';
import { Repository } from './repository.js';
import { Accounts } from './accounts.js';
import { Categories, ensureStarterCategories } from './categories.js';
import type { Kind, Owner, TransactionInput } from './domain.js';

/**
 * A small deterministic generator, so the household is the same every time.
 * `Math.random` would give a different article every reseed.
 */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The accounts the invented household holds.
 *
 * The banks are the real ones this application integrates with, which the
 * public repository already states; what a member keeps in them is what had to
 * be invented. `accountId` is what a connector would have reported, so the
 * registry, the balances and the transfer matching all key off it exactly as
 * they do for a real import.
 */
type ShowcaseAccount = {
  accountId: string;
  owner: Owner;
  source: string;
  label: string;
  currency: string;
  purpose: 'personal' | 'business' | 'investment';
};
export const SHOWCASE_ACCOUNTS: readonly ShowcaseAccount[] = [
  {
    accountId: 'mono-alex-black',
    owner: 'rodion',
    source: 'monobank',
    label: 'Black',
    currency: 'UAH',
    purpose: 'personal',
  },
  {
    accountId: 'mono-alex-iron',
    owner: 'rodion',
    source: 'monobank',
    label: 'Iron',
    currency: 'UAH',
    purpose: 'personal',
  },
  {
    accountId: 'mono-alex-fop',
    owner: 'rodion',
    source: 'monobank',
    label: 'FOP',
    currency: 'UAH',
    purpose: 'business',
  },
  {
    accountId: 'wise-alex-eur',
    owner: 'rodion',
    source: 'enablebanking',
    label: 'Wise EUR',
    currency: 'EUR',
    purpose: 'personal',
  },
  {
    accountId: 'revolut-alex-eur',
    owner: 'rodion',
    source: 'enablebanking',
    label: 'Revolut EUR',
    currency: 'EUR',
    purpose: 'personal',
  },
  {
    accountId: 'lhv-alex-eur',
    owner: 'rodion',
    source: 'enablebanking',
    label: 'LHV',
    currency: 'EUR',
    purpose: 'investment',
  },
  {
    accountId: 'mono-sam-white',
    owner: 'katya',
    source: 'monobank',
    label: 'White',
    currency: 'UAH',
    purpose: 'personal',
  },
  {
    accountId: 'wise-sam-eur',
    owner: 'katya',
    source: 'enablebanking',
    label: 'Wise EUR',
    currency: 'EUR',
    purpose: 'personal',
  },
  {
    accountId: 'swedbank-sam-eur',
    owner: 'katya',
    source: 'enablebanking',
    label: 'Swedbank',
    currency: 'EUR',
    purpose: 'personal',
  },
];

/**
 * Where the invented household shops, by category.
 *
 * These are the ordinary commerce of the country rather than anybody's own
 * history: naming a supermarket chain discloses nothing, and a list of plainly
 * fabricated merchants would make every screenshot look like a test fixture.
 * The spread per category is what gives the merchant and category screens
 * something to group.
 */
type Spend = {
  category: string;
  merchants: readonly string[];
  /** Minor units, inclusive range, in the account's own currency. */
  min: number;
  max: number;
  /** Roughly how many of these a month. */
  monthly: number;
  currency?: string;
};
const SPENDING: readonly Spend[] = [
  {
    category: 'food.groceries',
    merchants: ['Silpo', 'ATB', 'Varus', 'Novus', 'Auchan', 'Eco-Lavka'],
    min: 24000,
    max: 210000,
    monthly: 18,
  },
  {
    category: 'food.restaurants.dining',
    merchants: ['Puzata Hata', 'Veterano Pizza', 'Kyiv Food Market', 'Mimosa'],
    min: 32000,
    max: 165000,
    monthly: 6,
  },
  {
    category: 'food.restaurants.delivery',
    merchants: ['Glovo', 'Bolt Food', 'Rocket'],
    min: 28000,
    max: 98000,
    monthly: 4,
  },
  {
    category: 'food.alcohol',
    merchants: ['Wine Bureau', 'Good Wine'],
    min: 35000,
    max: 140000,
    monthly: 2,
  },
  {
    category: 'transport.car.fuel',
    merchants: ['WOG', 'OKKO', 'SOCAR'],
    min: 90000,
    max: 185000,
    monthly: 4,
  },
  {
    category: 'transport.ride_hailing',
    merchants: ['Uklon', 'Bolt'],
    min: 9000,
    max: 42000,
    monthly: 9,
  },
  {
    category: 'transport.public',
    merchants: ['Kyiv Metro', 'Kyivpastrans'],
    min: 1600,
    max: 4800,
    monthly: 6,
  },
  {
    category: 'health.pharmacy',
    merchants: ['Apteka ANC', 'Podorozhnyk', 'Bazhaemo Zdorovya'],
    min: 12000,
    max: 88000,
    monthly: 3,
  },
  {
    category: 'health.medical',
    merchants: ['Dobrobut', 'Medikom'],
    min: 60000,
    max: 320000,
    monthly: 1,
  },
  {
    category: 'sport.gym',
    merchants: ['Sport Life'],
    min: 85000,
    max: 85000,
    monthly: 1,
  },
  {
    category: 'beauty.services',
    merchants: ['Chop-Chop', 'Barber House'],
    min: 25000,
    max: 90000,
    monthly: 2,
  },
  {
    category: 'clothes',
    merchants: ['Zara', 'Intertop', 'Answear', 'LC Waikiki'],
    min: 45000,
    max: 380000,
    monthly: 2,
  },
  {
    category: 'electronics',
    merchants: ['Rozetka', 'Foxtrot', 'Comfy'],
    min: 40000,
    max: 620000,
    monthly: 1,
  },
  {
    category: 'home.goods',
    merchants: ['Epicentr', 'JYSK', 'IKEA'],
    min: 30000,
    max: 290000,
    monthly: 3,
  },
  {
    category: 'post_logistics',
    merchants: ['Nova Poshta', 'Ukrposhta'],
    min: 5500,
    max: 26000,
    monthly: 5,
  },
  {
    category: 'entertainment.events',
    merchants: ['Planeta Kino', 'Karabas', 'Atlas'],
    min: 20000,
    max: 150000,
    monthly: 2,
  },
  {
    category: 'pets',
    merchants: ['MasterZoo', 'Zoodim'],
    min: 15000,
    max: 95000,
    monthly: 2,
  },
  {
    category: 'gifts',
    merchants: ['Aromateque', 'Kvitna'],
    min: 40000,
    max: 220000,
    monthly: 1,
  },
  {
    category: 'apps_services',
    merchants: ['Spotify', 'Netflix', 'iCloud', 'GitHub'],
    min: 400,
    max: 2400,
    monthly: 4,
    currency: 'EUR',
  },
  {
    category: 'travel.accommodation',
    merchants: ['Booking.com', 'Airbnb'],
    min: 8000,
    max: 46000,
    monthly: 1,
    currency: 'EUR',
  },
];

/** Payments that arrive on the same day every month, which is what makes the
 * month-by-month chart look like a household rather than like noise. */
const RECURRING = [
  {
    day: 5,
    accountId: 'mono-alex-black',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '-1850000',
    description: 'Apartment rent',
    category: 'home.rent',
    kind: 'personal_expense' as Kind,
  },
  {
    day: 12,
    accountId: 'mono-alex-black',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '-320000',
    description: 'Housing utilities',
    category: 'home.utilities',
    kind: 'personal_expense' as Kind,
  },
  {
    day: 12,
    accountId: 'mono-alex-black',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '-24000',
    description: 'Kyivstar',
    category: 'communication.mobile',
    kind: 'personal_expense' as Kind,
  },
  {
    day: 14,
    accountId: 'mono-sam-white',
    owner: 'katya' as Owner,
    currency: 'UAH',
    amountMinor: '-24000',
    description: 'Vodafone',
    category: 'communication.mobile',
    kind: 'personal_expense' as Kind,
  },
  {
    day: 8,
    accountId: 'mono-alex-black',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '-52000',
    description: 'Volia internet',
    category: 'communication.internet',
    kind: 'personal_expense' as Kind,
  },
  {
    day: 3,
    accountId: 'mono-alex-fop',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '6800000',
    description: 'Client invoice',
    category: null,
    kind: 'non_personal' as Kind,
  },
  {
    day: 20,
    accountId: 'mono-alex-fop',
    owner: 'rodion' as Owner,
    currency: 'UAH',
    amountMinor: '-340000',
    description: 'Single tax and levy',
    category: null,
    kind: 'non_personal' as Kind,
  },
  {
    day: 10,
    accountId: 'mono-sam-white',
    owner: 'katya' as Owner,
    currency: 'UAH',
    amountMinor: '4200000',
    description: 'Salary',
    category: null,
    kind: 'non_personal' as Kind,
  },
] as const;

type Planned = {
  input: TransactionInput;
  kind: Kind;
  category: string | null;
  /** How this payment came to be classified, for the decision-coverage view. */
  decidedBy: 'human' | 'rule' | 'model' | 'mcc' | 'default';
};

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

/** The first day of the month `back` months before the month `from` sits in. */
function monthStart(from: Date, back: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - back, 1),
  );
}

/**
 * Sixteen months of a household's money, ending today.
 *
 * The dates are generated relative to the day it is seeded, so "this month" on
 * the Home screen is always the current one and the article's screenshots never
 * look abandoned. Reseeding is how the workspace stays current; there is no
 * timer, because it is only wanted before a screenshot.
 */
export function showcaseTransactions(now = new Date(), months = 16): Planned[] {
  const random = generator(0x5ea5ed);
  const planned: Planned[] = [];
  let counter = 0;
  const id = () => `showcase-${(counter += 1).toString(36)}`;
  const accountsByCurrency = (currency: string, owner: Owner) =>
    SHOWCASE_ACCOUNTS.filter(
      (a) =>
        a.currency === currency &&
        a.owner === owner &&
        a.purpose === 'personal',
    );

  for (let back = months - 1; back >= 0; back -= 1) {
    const start = monthStart(now, back);
    const daysInMonth = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
    ).getUTCDate();
    // The current month is only as long as it has got.
    const lastDay =
      back === 0 ? Math.min(now.getUTCDate(), daysInMonth) : daysInMonth;

    for (const fixed of RECURRING) {
      if (fixed.day > lastDay) continue;
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: fixed.accountId,
          owner: fixed.owner,
          bookedAt: new Date(
            Date.UTC(
              start.getUTCFullYear(),
              start.getUTCMonth(),
              fixed.day,
              9,
              15,
            ),
          ).toISOString(),
          currency: fixed.currency,
          amountMinor: fixed.amountMinor,
          description: fixed.description,
        },
        kind: fixed.kind,
        category: fixed.category,
        decidedBy: 'rule',
      });
    }

    for (const spend of SPENDING) {
      const currency = spend.currency ?? 'UAH';
      // A month's count varies, or every bar on the chart is the same height.
      const count = Math.max(
        1,
        Math.round(
          spend.monthly * (0.7 + random() * 0.6) * (lastDay / daysInMonth),
        ),
      );
      for (let n = 0; n < count; n += 1) {
        const owner: Owner = random() < 0.62 ? 'rodion' : 'katya';
        const candidates = accountsByCurrency(currency, owner);
        if (!candidates.length) continue;
        const account = pick(random, candidates);
        const day = 1 + Math.floor(random() * lastDay);
        const amount =
          spend.min + Math.floor(random() * (spend.max - spend.min + 1));
        planned.push({
          input: {
            source: 'showcase',
            sourceId: id(),
            accountId: account.accountId,
            owner,
            bookedAt: new Date(
              Date.UTC(
                start.getUTCFullYear(),
                start.getUTCMonth(),
                day,
                8 + Math.floor(random() * 12),
                Math.floor(random() * 60),
              ),
            ).toISOString(),
            currency,
            amountMinor: String(-amount),
            description: pick(random, spend.merchants),
          },
          kind: 'personal_expense',
          category: spend.category,
          decidedBy:
            random() < 0.55 ? 'rule' : random() < 0.6 ? 'mcc' : 'model',
        });
      }
    }

    // Money moved between the household's own accounts, which must not count
    // as spending: both sides exist, so the transfer matching has a real pair
    // to find rather than a lone outflow to guess about.
    if (lastDay >= 16) {
      const amount = 400000 + Math.floor(random() * 600000);
      const at = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 16, 11, 0),
      ).toISOString();
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: 'mono-alex-black',
          owner: 'rodion',
          bookedAt: at,
          currency: 'UAH',
          amountMinor: String(-amount),
          description: 'To Sam',
        },
        kind: 'internal_transfer',
        category: null,
        decidedBy: 'human',
      });
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: 'mono-sam-white',
          owner: 'katya',
          bookedAt: at,
          currency: 'UAH',
          amountMinor: String(amount),
          description: 'From Alex',
        },
        kind: 'internal_transfer',
        category: null,
        decidedBy: 'human',
      });
    }

    // Something bought and sent back. A refund is one of the more interesting
    // things the application does, so the screens need one to show.
    if (back % 4 === 1 && lastDay >= 24) {
      const amount = 120000 + Math.floor(random() * 200000);
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: 'mono-alex-black',
          owner: 'rodion',
          bookedAt: new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 21, 14, 30),
          ).toISOString(),
          currency: 'UAH',
          amountMinor: String(-amount),
          description: 'Rozetka',
        },
        kind: 'personal_expense',
        category: 'electronics',
        decidedBy: 'rule',
      });
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: 'mono-alex-black',
          owner: 'rodion',
          bookedAt: new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 24, 10, 5),
          ).toISOString(),
          currency: 'UAH',
          amountMinor: String(amount),
          description: 'Rozetka refund',
        },
        kind: 'personal_expense',
        category: 'electronics',
        decidedBy: 'human',
      });
    }

    // Money put aside. It leaves the headline figure but stays reachable,
    // which is the distinction the Analytics toggle exists to show.
    if (lastDay >= 18) {
      planned.push({
        input: {
          source: 'showcase',
          sourceId: id(),
          accountId: 'lhv-alex-eur',
          owner: 'rodion',
          bookedAt: new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 18, 12, 0),
          ).toISOString(),
          currency: 'EUR',
          amountMinor: String(-(40000 + Math.floor(random() * 30000))),
          description: 'Monthly investment',
        },
        kind: 'investment',
        category: null,
        decidedBy: 'human',
      });
    }
  }

  // A handful of payments nobody has decided yet, in the most recent weeks.
  // Unresolved money is shown as incompleteness rather than hidden, so the
  // screens need some for that to be visible at all.
  const pending = [
    { description: 'P2P transfer', amountMinor: '-260000' },
    { description: 'Card top-up', amountMinor: '-150000' },
    { description: 'PrivatBank transfer', amountMinor: '-88000' },
  ];
  pending.forEach((item, index) => {
    const at = new Date(now.getTime() - (2 + index * 3) * 86400000);
    planned.push({
      input: {
        source: 'showcase',
        sourceId: id(),
        accountId: 'mono-alex-black',
        owner: 'rodion',
        bookedAt: at.toISOString(),
        currency: 'UAH',
        amountMinor: item.amountMinor,
        description: item.description,
      },
      kind: 'unresolved',
      category: null,
      decidedBy: 'default',
    });
  });

  return planned;
}

/**
 * Fill a demo workspace with the invented household.
 *
 * Refuses anything but a local PGlite database. The seeder empties the ledger
 * before it writes, so pointed at the household's own PostgreSQL it would
 * destroy it; `isMemoryDatabase` answers from how the database was built
 * rather than from a variable that could be wrong.
 */
export async function seedShowcase(
  db: Database,
  options: { now?: Date; months?: number } = {},
): Promise<{ transactions: number; accounts: number }> {
  const now = options.now ?? new Date();
  if (!isMemoryDatabase(db))
    throw new Error(
      'refusing to seed: the showcase may only be written to a local demo database',
    );

  const repo = new Repository(db);
  const accounts = new Accounts(db);
  const categories = new Categories(db);
  await ensureStarterCategories(db);

  // A reseed replaces the household rather than adding a second one to it.
  await db.query(
    `DELETE FROM audit_events WHERE transaction_id IN
       (SELECT id FROM transactions WHERE source='showcase')`,
  );
  await db.query("DELETE FROM transactions WHERE source='showcase'");

  for (const account of SHOWCASE_ACCOUNTS)
    await accounts.upsert(
      {
        owner: account.owner,
        source: account.source,
        accountId: account.accountId,
        label: account.label,
        purpose: account.purpose,
        reason: 'Showcase household',
      },
      account.owner,
    );

  const planned = showcaseTransactions(now, options.months ?? 16);
  await repo.importBatch(planned.map((p) => p.input));

  // The ledger keys a payment by where it came from, so the generated ids map
  // straight back onto the rows that were just written.
  const rows = await db.query<{ id: string; source_id: string }>(
    "SELECT id, source_id FROM transactions WHERE source='showcase'",
  );
  const bySourceId = new Map(rows.rows.map((r) => [r.source_id, r.id]));

  const nodes = await categories.listNodes();
  const nodeByPath = new Map(
    nodes.map((n) => [String((n as { path?: string }).path ?? ''), n.id]),
  );

  for (const plan of planned) {
    const id = bySourceId.get(plan.input.sourceId);
    if (!id) continue;
    const categoryId = plan.category
      ? (await categories.resolve(plan.category)) ??
        nodeByPath.get(plan.category) ??
        null
      : null;
    await db.query(
      `UPDATE transactions SET kind=$1, category_id=$2, provisional=false,
         classification_source=$3, revision=revision+1, updated_at=now()
       WHERE id=$4`,
      [plan.kind, categoryId, plan.decidedBy, id],
    );
    // Enough decided payments carry a recorded decision for the history screen
    // to have something to show, without writing thousands of audit rows.
    if (plan.decidedBy === 'human')
      await db.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'rodion','classified',$3,$4,$5)`,
        [
          randomUUID(),
          id,
          JSON.stringify({ kind: 'unresolved', category: null, revision: 0 }),
          JSON.stringify({
            kind: plan.kind,
            category: plan.category,
            revision: 1,
          }),
          'Decided while reviewing the month',
        ],
      );
  }

  return { transactions: planned.length, accounts: SHOWCASE_ACCOUNTS.length };
}
