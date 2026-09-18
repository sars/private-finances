/**
 * The addresses of a bitcoin wallet from its extended public key.
 *
 * A wallet is one seed that yields addresses in a fixed order and hands out
 * a fresh one for every receipt, so a single address says nothing about the
 * wallet's balance. The account-level extended public key (`zpub` for a
 * native-segwit wallet, `ypub` for wrapped segwit, `xpub` for legacy) lets
 * anyone derive every receive and change address without being able to
 * spend, which is exactly what a read-only feed needs.
 *
 * Everything here is BIP32 public child derivation on secp256k1, BIP44/49/84
 * address encoding and a gap-limit scan, written against the standard's test
 * vectors with Node's own hashes; no dependency, no network in this module
 * except through the injected lookup.
 */
import { createHash, createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// secp256k1, affine coordinates, BigInt
// ---------------------------------------------------------------------------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};
type Point = { x: bigint; y: bigint } | null;
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function inverse(a: bigint, m = P): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('not_invertible');
  return mod(old_s, m);
}
function addPoints(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y) === 0n) return null;
    const l = mod(3n * a.x * a.x * inverse(2n * a.y));
    const x = mod(l * l - 2n * a.x);
    return { x, y: mod(l * (a.x - x) - a.y) };
  }
  const l = mod((b.y - a.y) * inverse(b.x - a.x));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
function multiply(point: Point, k: bigint): Point {
  let result: Point = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
    k >>= 1n;
  }
  return result;
}
function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  base = mod(base, m);
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exponent >>= 1n;
  }
  return result;
}
function decompress(key: Uint8Array): Point {
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3))
    throw new Error('invalid_public_key');
  const x = BigInt('0x' + Buffer.from(key.subarray(1)).toString('hex'));
  if (x >= P) throw new Error('invalid_public_key');
  // p ≡ 3 (mod 4), so the square root is c^((p+1)/4).
  const y2 = mod(x * x * x + 7n);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) throw new Error('invalid_public_key');
  if ((y & 1n) !== BigInt(key[0]! & 1)) y = P - y;
  return { x, y };
}
function compress(point: Point): Buffer {
  if (!point) throw new Error('point_at_infinity');
  return Buffer.concat([
    Buffer.from([point.y & 1n ? 3 : 2]),
    Buffer.from(point.x.toString(16).padStart(64, '0'), 'hex'),
  ]);
}

// ---------------------------------------------------------------------------
// Base58Check and Bech32
// ---------------------------------------------------------------------------
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();
const hash160 = (data: Uint8Array) =>
  createHash('ripemd160').update(sha256(data)).digest();

export function base58Decode(text: string): Buffer {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error('invalid_base58');
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(value === 0n ? '' : hex, 'hex');
  let leading = 0;
  for (const char of text) {
    if (char !== '1') break;
    leading += 1;
  }
  return Buffer.concat([Buffer.alloc(leading), body]);
}
export function base58Encode(bytes: Uint8Array): string {
  let value = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}
function base58CheckDecode(text: string): Buffer {
  const raw = base58Decode(text);
  if (raw.length < 5) throw new Error('invalid_base58check');
  const payload = raw.subarray(0, -4);
  const check = sha256(sha256(payload)).subarray(0, 4);
  if (!check.equals(raw.subarray(-4))) throw new Error('invalid_base58check');
  return Buffer.from(payload);
}
function base58CheckEncode(payload: Uint8Array): string {
  const check = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([Buffer.from(payload), check]));
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values: number[]): number {
  const generator = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generator[i]!;
  }
  return chk;
}
function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0,
    bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & max);
  return out;
}
/** A version-0 segwit address (P2WPKH) for a 20-byte program. */
export function bech32Address(program: Uint8Array, hrp = 'bc'): string {
  const data = [0, ...convertBits(program, 8, 5)];
  const expanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from(
    { length: 6 },
    (_, i) => (polymod >> (5 * (5 - i))) & 31,
  );
  return `${hrp}1${[...data, ...checksum].map((d) => BECH32[d]).join('')}`;
}

// ---------------------------------------------------------------------------
// Extended public keys and address derivation
// ---------------------------------------------------------------------------
export type AddressKind = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
const VERSIONS: Record<string, AddressKind> = {
  '0488b21e': 'p2pkh', // xpub
  '049d7cb2': 'p2sh-p2wpkh', // ypub
  '04b24746': 'p2wpkh', // zpub
};
export interface ExtendedPublicKey {
  kind: AddressKind;
  depth: number;
  chainCode: Buffer;
  key: Buffer;
}
export function isExtendedPublicKey(text: string): boolean {
  return /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(text.trim());
}
export function parseExtendedPublicKey(text: string): ExtendedPublicKey {
  const payload = base58CheckDecode(text.trim());
  if (payload.length !== 78) throw new Error('invalid_extended_key');
  const kind = VERSIONS[payload.subarray(0, 4).toString('hex')];
  if (!kind) throw new Error('unsupported_extended_key');
  const key = Buffer.from(payload.subarray(45, 78));
  decompress(key); // a private key or garbage does not decompress
  return {
    kind,
    depth: payload[4]!,
    chainCode: Buffer.from(payload.subarray(13, 45)),
    key,
  };
}
/** BIP32 non-hardened public child: HMAC over the parent key and index, added to the parent point. */
export function deriveChild(
  parent: { chainCode: Buffer; key: Buffer },
  index: number,
): { chainCode: Buffer; key: Buffer } {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000)
    throw new Error('invalid_child_index');
  const data = Buffer.alloc(37);
  parent.key.copy(data, 0);
  data.writeUInt32BE(index, 33);
  const I = createHmac('sha512', parent.chainCode).update(data).digest();
  const il = BigInt('0x' + I.subarray(0, 32).toString('hex'));
  if (il >= N) throw new Error('invalid_child');
  const point = addPoints(multiply(G, il), decompress(parent.key));
  if (!point) throw new Error('invalid_child');
  return { chainCode: Buffer.from(I.subarray(32)), key: compress(point) };
}
export function addressFor(publicKey: Uint8Array, kind: AddressKind): string {
  const program = hash160(publicKey);
  switch (kind) {
    case 'p2wpkh':
      return bech32Address(program);
    case 'p2pkh':
      return base58CheckEncode(Buffer.concat([Buffer.from([0x00]), program]));
    case 'p2sh-p2wpkh': {
      const redeem = Buffer.concat([Buffer.from([0x00, 0x14]), program]);
      return base58CheckEncode(
        Buffer.concat([Buffer.from([0x05]), hash160(redeem)]),
      );
    }
  }
}
/** The i-th address of the receive (0) or change (1) chain under an account key. */
export function walletAddress(
  account: ExtendedPublicKey,
  chain: 0 | 1,
  index: number,
): string {
  const branch = deriveChild(account, chain);
  return addressFor(deriveChild(branch, index).key, account.kind);
}

// ---------------------------------------------------------------------------
// Gap-limit scan
// ---------------------------------------------------------------------------
export interface AddressActivity {
  /** Transactions ever seen for the address, confirmed or pending. */
  transactions: number;
  /** Balance in satoshis, confirmed plus pending. */
  satoshis: bigint;
}
export type AddressLookup = (address: string) => Promise<AddressActivity>;
/** Unused addresses in a row after which a chain is considered exhausted; the BIP44 convention. */
export const GAP_LIMIT = 20;
/** A hard stop per chain so a hostile or broken lookup cannot run forever. */
export const MAX_ADDRESSES_PER_CHAIN = 500;

/** The wallet's balance in satoshis, scanning both chains up to the gap limit. */
export async function scanWallet(
  account: ExtendedPublicKey,
  lookup: AddressLookup,
): Promise<{
  satoshis: bigint;
  addressesUsed: number;
  addressesChecked: number;
}> {
  let satoshis = 0n,
    used = 0,
    checked = 0;
  for (const chain of [0, 1] as const) {
    const branch = deriveChild(account, chain);
    let unusedInARow = 0;
    for (let index = 0; index < MAX_ADDRESSES_PER_CHAIN; index++) {
      const address = addressFor(deriveChild(branch, index).key, account.kind);
      const activity = await lookup(address);
      checked += 1;
      if (activity.transactions > 0) {
        used += 1;
        unusedInARow = 0;
        satoshis += activity.satoshis;
      } else if (++unusedInARow >= GAP_LIMIT) break;
    }
  }
  return { satoshis, addressesUsed: used, addressesChecked: checked };
}
