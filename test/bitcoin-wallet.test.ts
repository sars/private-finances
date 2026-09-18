import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base58Decode,
  base58Encode,
  bech32Address,
  deriveChild,
  isExtendedPublicKey,
  parseExtendedPublicKey,
  scanWallet,
  walletAddress,
  GAP_LIMIT,
} from '../src/bitcoin-wallet.js';

// BIP84 test vector: the "abandon … about" mnemonic's account key and its
// first addresses, published with the standard.
const bip84 =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
// BIP49 test vector for the same mnemonic (account 0), and BIP44 through the
// widely published xpub of that account.
const bip49 =
  'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
const bip44 =
  'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';

test('the standard test vectors derive the published addresses for all three key kinds', () => {
  const z = parseExtendedPublicKey(bip84);
  assert.equal(z.kind, 'p2wpkh');
  assert.equal(z.depth, 3);
  assert.equal(
    walletAddress(z, 0, 0),
    'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  );
  assert.equal(
    walletAddress(z, 0, 1),
    'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  );
  assert.equal(
    walletAddress(z, 1, 0),
    'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
  );
  const y = parseExtendedPublicKey(bip49);
  assert.equal(y.kind, 'p2sh-p2wpkh');
  assert.equal(walletAddress(y, 0, 0), '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  const x = parseExtendedPublicKey(bip44);
  assert.equal(x.kind, 'p2pkh');
  assert.equal(walletAddress(x, 0, 0), '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
});

test('extended keys are recognised, validated and rejected when malformed', () => {
  assert.equal(isExtendedPublicKey(bip84), true);
  assert.equal(
    isExtendedPublicKey('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'),
    false,
  );
  assert.throws(
    () => parseExtendedPublicKey(bip84.slice(0, -1) + 't'),
    /invalid_base58check/,
  );
  assert.throws(
    () =>
      parseExtendedPublicKey(
        'tpubDC5FSnBiZDMmhiuCmWAYsLwgLYrrT9rAqvTySfuCCrgsWz8wxMXUS9Tb9iVMvcRbvFcAHGkMD5Kx8koh4GquNGNTfohfk7pgjhaPCdXpoba',
      ),
    /unsupported_extended_key/,
  );
  assert.throws(
    () => deriveChild(parseExtendedPublicKey(bip84), 0x80000000),
    /invalid_child_index/,
  );
  const bytes = Buffer.from([0, 0, 1, 2, 255]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  assert.equal(
    bech32Address(
      Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex'),
    ),
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  );
});

test('the scan sums used addresses on both chains and stops after the gap limit', async () => {
  const account = parseExtendedPublicKey(bip84);
  const funded = new Map<string, bigint>([
    [walletAddress(account, 0, 0), 100n],
    [walletAddress(account, 0, 3), 250n],
    [walletAddress(account, 1, 0), 7n],
  ]);
  const asked: string[] = [];
  const result = await scanWallet(account, async (address) => {
    asked.push(address);
    const satoshis = funded.get(address);
    return satoshis === undefined
      ? { transactions: 0, satoshis: 0n }
      : { transactions: 1, satoshis };
  });
  assert.equal(result.satoshis, 357n);
  assert.equal(result.addressesUsed, 3);
  // Receive chain: indices 0..3 used or skipped, then 20 unused → 24; change: 1 used + 20 → 21.
  assert.equal(result.addressesChecked, 4 + GAP_LIMIT + 1 + GAP_LIMIT);
  assert.equal(new Set(asked).size, asked.length);
});
