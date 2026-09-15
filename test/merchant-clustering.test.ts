import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clusterMerchants,
  merchantKey,
  type ClusterMember,
} from '../src/merchant-clustering.js';

const member = (
  description: string,
  category: string | null = null,
  decidedByPerson = false,
): ClusterMember => ({ description, category, decidedByPerson });

test('CAT-11 a merchant key survives the parts a bank varies per payment', () => {
  // The whole point: one merchant, four descriptions, one key.
  for (const description of [
    'BOLT RIGA 111',
    'BOLT RIGA 222',
    'Bolt,Riga,LV',
    'SIA BOLT RIGA',
  ])
    assert.equal(merchantKey(description), 'bolt', description);
});

test('CAT-11 a key drops what carries no identifying power', () => {
  // Legal form, country and city come from merchantTokens, which receipt
  // matching already relies on.
  assert.equal(merchantKey('SIA RIMI LATVIA'), 'rimi');
  assert.equal(merchantKey('Rimi Riga Marijas'), 'rimi');
  // Numbers are dropped here but not in receipt matching: a reference number
  // would otherwise become a merchant and pull unrelated payments together.
  assert.equal(merchantKey('4829 111222'), null);
  assert.equal(merchantKey('123 456'), null);
  // Nothing identifying at all is null rather than a guess.
  assert.equal(merchantKey(''), null);
  assert.equal(merchantKey('SIA LV'), null);
});

test('CAT-11 a Ukrainian legal form or ordinary word is not a merchant', () => {
  // Measuring the real ledger found these heading large false clusters: the
  // stop-word list was Latin-script only, so the Ukrainian sole trader form and
  // the word "top-up" were treated as merchant names. "поповнення" alone pulled
  // 201 payments together across phone top-ups and donations.
  assert.equal(merchantKey('ПОПОВНЕННЯ 1234'), null);
  assert.equal(merchantKey('ФОП 5678'), null);
  assert.equal(merchantKey('ТОВ 9012'), null);
  assert.equal(merchantKey('ПАРКІНГ'), null);
  // A real name still survives beside the stripped form.
  assert.equal(merchantKey('ФОП Розетка'), 'розетка');
  assert.equal(merchantKey('ТОВ Сільпо Київ'), 'сільпо');
  // And the Latin-script fillers that had slipped through.
  assert.equal(merchantKey('WWW 123'), null);
  assert.equal(merchantKey('THE 456'), null);
  assert.equal(merchantKey('WWW.OLX.UA'), 'olx');
});

test('CAT-11 clustering counts agreement and disagreement separately', () => {
  const report = clusterMerchants([
    // Agrees: two descriptions, one category.
    member('BOLT RIGA 1', 'Transport / Ride-hailing'),
    member('BOLT RIGA 2', 'Transport / Ride-hailing'),
    // Disagrees within one branch: the distinction is real but small.
    member('WOLT 1', 'Food / Restaurants / Delivery'),
    member('WOLT 2', 'Food / Restaurants / Dining in'),
    // Disagrees across branches, and both were chosen by a person, so the
    // merchant genuinely spans two purposes.
    member('CIRCLE K 1', 'Transport / Car / Fuel', true),
    member('CIRCLE K 2', 'Food / Groceries', true),
    // No category yet: purity can say nothing about it.
    member('UNSEEN MERCHANT'),
  ]);
  assert.equal(report.descriptions, 7);
  assert.equal(report.keyed, 7);
  assert.equal(report.clusters, 4);
  assert.equal(report.multiDescriptionClusters, 3);
  assert.equal(report.absorbedDescriptions, 6);
  assert.equal(report.pureClusters, 1);
  assert.equal(report.mixedClusters, 2);
  assert.equal(report.mixedButSameBranch, 1);
  assert.equal(report.mixedWithTwoHumanDecisions, 1);
  assert.equal(report.unjudgedClusters, 1);
});

test('CAT-11 a description with no identifying key is left out, not bucketed', () => {
  const report = clusterMerchants([
    member('111 222', 'Unspecified'),
    member('BOLT 1', 'Transport / Ride-hailing'),
  ]);
  assert.equal(report.descriptions, 2);
  assert.equal(report.keyed, 1, 'the numeric description produced no key');
  assert.equal(report.clusters, 1);
  assert.ok(!report.byKey.has(''), 'an empty key is never a cluster');
});

test('CAT-11 an automatic category alone does not count as two human decisions', () => {
  const report = clusterMerchants([
    // Not "SHOP": that is a stop word, so the description would carry no key.
    member('MAXIMA 1', 'Food / Groceries', true),
    member('MAXIMA 2', 'Home / Goods', false),
  ]);
  assert.equal(report.mixedClusters, 1);
  assert.equal(
    report.mixedWithTwoHumanDecisions,
    0,
    'one human decision against a machine guess is not a real conflict',
  );
});
