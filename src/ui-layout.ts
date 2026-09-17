import { Conflict } from './repository.js';
import type { Database, Executor } from './database.js';
import type { Owner } from './domain.js';

/**
 * Where each person has chosen to put things on a screen.
 *
 * This is a per-person preference, not household configuration: the existing
 * settings store is administrator-only and holds decisions that change what the
 * figures mean, whereas the order of cards changes nothing but the view. Both
 * members write here for themselves, and neither can read or move the other's
 * arrangement.
 *
 * The stored value is a list of keys in the order the person put them. It is
 * deliberately not a complete description of the screen: anything the list does
 * not mention keeps its natural position after the ones it does, so an account
 * opened tomorrow appears without the layout having to be rewritten, and an
 * account that closes leaves a key behind that simply never matches again.
 */
export type Layout = { ordering: string[]; revision: number };

/** One card's key. Long enough for `source:account_id`, and nothing exotic. */
const KEY = /^[A-Za-z0-9:_.-]{1,200}$/;
const MAX_ENTRIES = 200;

export async function initializeUiLayouts(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS ui_layouts (
      owner text NOT NULL CHECK(owner IN ('rodion','katya')),
      layout_key text NOT NULL CHECK(layout_key ~ '^[a-z][a-z-]{0,39}$'),
      ordering jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner,layout_key)
    )`);
}

/**
 * The keys of a stored or submitted arrangement, rejected outright rather than
 * repaired when they are not a plain list of short unique strings. A layout is
 * cosmetic, so a malformed one is worth an error the caller sees rather than a
 * silent correction that leaves the person's screen subtly not what they set.
 */
function ordering(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES)
    throw new Error('invalid_layout');
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !KEY.test(entry) || seen.has(entry))
      throw new Error('invalid_layout');
    seen.add(entry);
  }
  return value as string[];
}

export class UiLayouts {
  constructor(readonly db: Database) {}

  /** What this person arranged, or an empty layout when they never have. */
  async get(owner: Owner, key: string): Promise<Layout> {
    const found = await this.db.query(
      'SELECT ordering,revision FROM ui_layouts WHERE owner=$1 AND layout_key=$2',
      [owner, key],
    );
    const row = found.rows[0];
    if (!row) return { ordering: [], revision: 0 };
    return {
      ordering: ordering(row.ordering),
      revision: Number(row.revision ?? 0),
    };
  }

  /**
   * Record an arrangement, refusing one written against a version the person no
   * longer has. The same optimistic check the settings screen uses: two tabs
   * open on the same screen must not silently overwrite each other, and the
   * loser is told to look again rather than having its order applied last.
   */
  async save(
    owner: Owner,
    key: string,
    value: unknown,
    revision: number,
  ): Promise<Layout> {
    const next = ordering(value);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid_layout');
    return this.db.transaction(async (tx) => {
      const current = await tx.query(
        'SELECT revision FROM ui_layouts WHERE owner=$1 AND layout_key=$2 FOR UPDATE',
        [owner, key],
      );
      const held = current.rows[0] ? Number(current.rows[0].revision ?? 0) : 0;
      if (held !== revision) throw new Conflict('layout_revision_conflict');
      const saved = await tx.query(
        `INSERT INTO ui_layouts(owner,layout_key,ordering,revision,updated_at)
         VALUES($1,$2,$3::jsonb,1,now())
         ON CONFLICT(owner,layout_key) DO UPDATE SET
           ordering=EXCLUDED.ordering, revision=ui_layouts.revision+1, updated_at=now()
         RETURNING ordering,revision`,
        [owner, key, JSON.stringify(next)],
      );
      const row = saved.rows[0]!;
      return {
        ordering: ordering(row.ordering),
        revision: Number(row.revision ?? 0),
      };
    });
  }
}

/**
 * Put items in the person's chosen order.
 *
 * Anything they have placed comes first, in their order; everything else keeps
 * the order it arrived in, behind. That rule is what lets a new account show up
 * on a screen somebody arranged months ago without the stored layout knowing
 * anything about it.
 */
export function arrange<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(keyOf(item)) }))
    .sort((a, b) =>
      a.rank === b.rank
        ? a.index - b.index
        : a.rank === undefined
          ? 1
          : b.rank === undefined
            ? -1
            : a.rank - b.rank,
    )
    .map((entry) => entry.item);
}
