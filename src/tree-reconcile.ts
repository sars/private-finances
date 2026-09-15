import { randomUUID } from 'node:crypto';
import type { Executor } from './database.js';

/**
 * Bringing the tree to the shape the owner described (ADR 0008, step D3).
 *
 * Almost all of it is reparenting and renaming, which costs nothing: a payment
 * points at a node, and the path text is derived, so moving a node changes every
 * affected path without touching a single `category_id`. Only one change moves
 * payments, and it does so through the auditable path.
 *
 * What the owner asked for, and what it costs:
 *
 * - **Utilities becomes a top-level branch.** They listed "utility bills,
 *   including all utilities — possibly communications such as a phone top-up" as
 *   one thing and home goods as another, which the shipped shape answered
 *   neither way: Utilities was a leaf inside Home while phone and internet sat in
 *   a separate Communication branch. The old `Home / Utilities` node is
 *   reparented and renamed `Housing utilities`, the three Communication leaves
 *   move beside it, and the empty Communication branch is deleted. No payment
 *   moves.
 * - **Travel / Travel transport is retired.** The owner puts flights and carpool
 *   under transport, so its payments move to `Transport / Long distance`. This is
 *   the one real move, and the accepted consequence is that the Travel total no
 *   longer includes flights until the trip tag exists.
 *
 * `Ride-hailing` keeps its name: the owner declined the rename, because a name
 * differing from their wording is not a defect while a question they cannot
 * answer is.
 */

async function nodeBySlug(
  tx: Executor,
  slug: string,
): Promise<{ id: string; parent_id: string | null } | undefined> {
  const found = await tx.query(
    'SELECT id, parent_id FROM category_tree WHERE slug=$1',
    [slug],
  );
  const row = found.rows[0];
  return row
    ? {
        id: String(row.id),
        parent_id: row.parent_id === null ? null : String(row.parent_id),
      }
    : undefined;
}

export type TreeReconcileReport = {
  /** Nodes reparented or renamed; no payment changed category. */
  restructured: number;
  /** Payments moved to another leaf, each with an audit event. */
  moved: number;
  /** Rules repointed at the surviving leaf. */
  rulesRepointed: number;
};

export async function reconcileTree(
  tx: Executor,
): Promise<TreeReconcileReport> {
  const report: TreeReconcileReport = {
    restructured: 0,
    moved: 0,
    rulesRepointed: 0,
  };

  // --- Utilities becomes its own branch -----------------------------------
  let utilities = await nodeBySlug(tx, 'utilities');
  if (!utilities) {
    const id = randomUUID();
    // Between Home and Transport, so the branch reads where the owner expects.
    await tx.query(
      `INSERT INTO category_tree(id,slug,name,parent_id,depth,sort_order)
       VALUES($1,'utilities','Utilities',NULL,1,25)`,
      [id],
    );
    utilities = { id, parent_id: null };
    report.restructured++;
  }
  // The former `Home / Utilities` keeps its slug and its id, so every payment
  // filed on it follows automatically and its history stays intact.
  const housing = await nodeBySlug(tx, 'home.utilities');
  if (housing && housing.parent_id !== utilities.id) {
    await tx.query(
      "UPDATE category_tree SET parent_id=$1, name='Housing utilities', sort_order=10 WHERE id=$2",
      [utilities.id, housing.id],
    );
    report.restructured++;
  }
  for (const [slug, order] of [
    ['communication.mobile', 20],
    ['communication.internet', 30],
    ['communication.unspecified', 9999],
  ] as const) {
    const leaf = await nodeBySlug(tx, slug);
    if (leaf && leaf.parent_id !== utilities.id) {
      await tx.query(
        'UPDATE category_tree SET parent_id=$1, sort_order=$2 WHERE id=$3',
        [utilities.id, order, leaf.id],
      );
      report.restructured++;
    }
  }
  const communication = await nodeBySlug(tx, 'communication');
  if (communication) {
    const children = await tx.query(
      'SELECT 1 FROM category_tree WHERE parent_id=$1 LIMIT 1',
      [communication.id],
    );
    // Deleting a branch that still had children would orphan them; by now it
    // has none, and it never held a payment because a branch is not assignable.
    if (!children.rows.length) {
      await tx.query('DELETE FROM category_tree WHERE id=$1', [
        communication.id,
      ]);
      report.restructured++;
    }
  }

  // --- Travel transport retires into Transport / Long distance ------------
  const travelTransport = await nodeBySlug(tx, 'travel.transport');
  const longDistance = await nodeBySlug(tx, 'transport.long_distance');
  if (travelTransport && longDistance) {
    const moved = await tx.query(
      `UPDATE transactions SET category_id=$1, revision=revision+1, updated_at=now()
       WHERE category_id=$2 RETURNING id`,
      [longDistance.id, travelTransport.id],
    );
    for (const row of moved.rows)
      await tx.query(
        `INSERT INTO audit_events(id,transaction_id,actor,event,before_value,after_value,reason)
         VALUES($1,$2,'tree_reconcile','category_moved',$3,$4,$5)`,
        [
          randomUUID(),
          String(row.id),
          JSON.stringify({ categoryId: travelTransport.id }),
          JSON.stringify({ categoryId: longDistance.id }),
          'The owner places flights and carpool under transport, so Travel transport is retired',
        ],
      );
    report.moved = moved.rows.length;
    const rules = await tx.query(
      'UPDATE classification_rules SET category_id=$1 WHERE category_id=$2 RETURNING id',
      [longDistance.id, travelTransport.id],
    );
    report.rulesRepointed = rules.rows.length;
    await tx.query('DELETE FROM category_tree WHERE id=$1', [
      travelTransport.id,
    ]);
    report.restructured++;
  }

  return report;
}
