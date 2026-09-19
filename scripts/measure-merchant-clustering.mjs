// Measure whether merchant identity can be recognised across the descriptions a
// bank prints (CAT-11), before anything depends on it. Read-only: it makes no
// decision and writes nothing.
//
//   sudo -u private-finances node scripts/measure-merchant-clustering.mjs
//   node scripts/measure-merchant-clustering.mjs --detail   # adds examples
//
// Aggregates are safe to share. `--detail` prints merchant keys and category
// paths, which are private financial evidence: keep that output off GitHub, out
// of logs and out of a model prompt.
import { postgresDatabase } from '../dist/src/database.js';
import {
  clusterMerchants,
  merchantKey,
} from '../dist/src/merchant-clustering.js';

const detail = process.argv.includes('--detail');
const url =
  process.env.DATABASE_URL ??
  'postgresql:///private_finances?host=/var/run/postgresql';
const db = postgresDatabase(url);

// One row per payment that carries a description, with the category it holds and
// whether a person chose it. A person's decision is the only evidence strong
// enough to judge a cluster against.
const rows = (
  await db.query(`SELECT t.description, t.category,
     EXISTS(SELECT 1 FROM audit_events a
            WHERE a.transaction_id=t.id AND a.event='classified') AS by_person
   FROM transactions t WHERE btrim(t.description) <> ''`)
).rows;

const report = clusterMerchants(
  rows.map((row) => ({
    description: String(row.description),
    category: row.category === null ? null : String(row.category),
    decidedByPerson: Boolean(row.by_person),
  })),
);

const judged = report.pureClusters + report.mixedClusters;
const percent = (part, whole) =>
  whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;

console.log('payments with a description   ', report.descriptions);
console.log('produced a merchant key      ', report.keyed);
console.log('distinct merchant keys       ', report.clusters);
console.log(
  'keys covering >1 description ',
  report.multiDescriptionClusters,
  `(absorbing ${report.absorbedDescriptions} descriptions)`,
);
console.log('');
console.log('clusters judged by category   ', judged);
console.log(
  '  all members agree          ',
  report.pureClusters,
  percent(report.pureClusters, judged),
);
console.log(
  '  members disagree           ',
  report.mixedClusters,
  percent(report.mixedClusters, judged),
);
console.log('    but agree on the branch  ', report.mixedButSameBranch);
console.log('    two human decisions      ', report.mixedWithTwoHumanDecisions);
console.log('clusters with no category     ', report.unjudgedClusters);

// How much of the rule sediment one merchant key would absorb.
const rules = (
  await db.query(
    "SELECT owner, match_value FROM classification_rules WHERE active AND match_field='description'",
  )
).rows;
const ruleKeys = new Set();
let keyless = 0;
for (const rule of rules) {
  const key = merchantKey(String(rule.match_value));
  if (key === null) keyless++;
  else ruleKeys.add(key);
}
console.log('');
console.log('active description rules      ', rules.length);
console.log('distinct merchant keys in them', ruleKeys.size);
console.log('rules with no identifying key ', keyless);

if (detail) {
  console.log('\n--- private: largest mixed clusters ---');
  const mixed = [...report.byKey.entries()]
    .map(([key, members]) => {
      const categories = new Set(
        members.filter((m) => m.category).map((m) => m.category),
      );
      return { key, members: members.length, categories: [...categories] };
    })
    .filter((entry) => entry.categories.length > 1)
    .sort((a, b) => b.members - a.members)
    .slice(0, 25);
  for (const entry of mixed)
    console.log(
      `${entry.key} · ${entry.members} payments · ${entry.categories.join(' | ')}`,
    );
}

await db.close();
