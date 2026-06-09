// sdk/src/crypto/keys.ts
// shielded key derivation using grumpkin (the embedded curve for bn254).
// important: noirs std::embedded_curve_ops when proving with barretenberg
// operates on grumpkin, not babyjubjub. our sdk must use the same curve.

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { BIP39_WORDLIST } from './bip39-wordlist.js';
import { poseidon2 } from './poseidon.js';
import { deriveGrumpkinPubkey, GRUMPKIN_ORDER } from './schnorr.js';
import { fieldToBytes32, bytes32ToField, bytesToBigInt, base58Encode, base58Decode } from '../utils/encoding.js';
import { BN254_FIELD_PRIME } from '../utils/types.js';
import type { Field, ShieldedKeypair, CurvePoint } from '../utils/types.js';

const VIEWING_KEY_DOMAIN = 1n;
const NULLIFIER_DOMAIN = 2n;

export async function generateShieldedKeypair(): Promise<ShieldedKeypair> {
  let spendingKey: Field;
  do {
    const raw = bytesToBigInt(randomBytes(32));
    spendingKey = raw % GRUMPKIN_ORDER;
  } while (spendingKey === 0n);
  return deriveKeypairFromSpendingKey(spendingKey);
}

// bip-39 mnemonic functions
// standard bip-39 encoding: 128 bits entropy → sha-256 checksum (first 4 bits)
// → 132 bits total → 12 words × 11 bits each.
// the spending key is derived deterministically: sha-256(mnemonic string) mod grumpkin_order.
// this is the metamask/exodus approach — the 12 words are the master secret.

/**
 * Generate a new 12-word BIP-39 mnemonic phrase.
 * Returns the 12 words as an array.
 */
export function generateMnemonic(): string[] {
  const entropy = randomBytes(16); // 128 bits
  const hash = sha256(entropy);
  const checksumBits = (hash[0]! >> 4) & 0x0f; // first 4 bits of SHA-256

  // combine entropy (128 bits) + checksum (4 bits) = 132 bits
  // convert to a single big number for bit extraction
  let combined = 0n;
  for (const byte of entropy) {
    combined = (combined << 8n) | BigInt(byte);
  }
  combined = (combined << 4n) | BigInt(checksumBits);

  // extract 12 groups of 11 bits (from msb to lsb)
  const words: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const index = Number((combined >> BigInt(i * 11)) & 0x7ffn); // 11 bits = 0x7ff = 2047
    words.push(BIP39_WORDLIST[index]!);
  }
  return words;
}

/**
 * Validate that a mnemonic consists of valid BIP-39 words and has correct checksum.
 */
export function validateMnemonic(words: string[]): { valid: boolean; invalidWords: number[] } {
  if (words.length !== 12) return { valid: false, invalidWords: [] };

  const invalidWords: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase().trim();
    const idx = BIP39_WORDLIST.indexOf(w);
    if (idx === -1) {
      invalidWords.push(i);
    } else {
      indices.push(idx);
    }
  }

  if (invalidWords.length > 0) return { valid: false, invalidWords };

  // reconstruct the 132-bit value from word indices
  let combined = 0n;
  for (const idx of indices) {
    combined = (combined << 11n) | BigInt(idx);
  }

  // extract entropy (top 128 bits) and checksum (bottom 4 bits)
  const checksumFromWords = Number(combined & 0xfn);
  const entropyBits = combined >> 4n;

  // convert entropy back to bytes
  const entropyBytes = new Uint8Array(16);
  let ev = entropyBits;
  for (let i = 15; i >= 0; i--) {
    entropyBytes[i] = Number(ev & 0xffn);
    ev >>= 8n;
  }

  // verify checksum
  const hash = sha256(entropyBytes);
  const expectedChecksum = (hash[0]! >> 4) & 0x0f;

  return { valid: checksumFromWords === expectedChecksum, invalidWords: [] };
}

/**
 * Derive a spending key from a 12-word BIP-39 mnemonic.
 * Uses SHA-256 of the mnemonic string, reduced mod GRUMPKIN_ORDER.
 */
export function mnemonicToSpendingKey(words: string[]): Field {
  const { valid, invalidWords } = validateMnemonic(words);
  if (!valid) {
    if (invalidWords.length > 0) {
      throw new Error(`Invalid BIP-39 words at positions: ${invalidWords.join(', ')}`);
    }
    throw new Error('Invalid mnemonic checksum');
  }
  const phrase = words.map(w => w.toLowerCase().trim()).join(' ');
  const hash = sha256(new TextEncoder().encode(phrase));
  let key = bytesToBigInt(hash) % GRUMPKIN_ORDER;
  if (key === 0n) key = 1n;
  return key;
}

export async function deriveKeypairFromSpendingKey(spendingKey: Field): Promise<ShieldedKeypair> {
  if (spendingKey <= 0n || spendingKey >= GRUMPKIN_ORDER) {
    throw new Error('Spending key out of Grumpkin subgroup order range');
  }
  const viewingKey = await poseidon2([spendingKey, VIEWING_KEY_DOMAIN]);
  let vk = viewingKey % GRUMPKIN_ORDER;
  if (vk === 0n) vk = 1n;
  const shieldedPt = await deriveGrumpkinPubkey(spendingKey);
  const viewingPt = await deriveGrumpkinPubkey(vk);
  return {
    spendingKey,
    viewingKey,
    shieldedPk: { x: shieldedPt.x, y: shieldedPt.y },
    viewingPk: { x: viewingPt.x, y: viewingPt.y },
  };
}

export async function keypairFromSeedPhrase(seedPhrase: string): Promise<ShieldedKeypair> {
  const bytes = sha256(new TextEncoder().encode(seedPhrase));
  let scalar = bytesToBigInt(bytes) % GRUMPKIN_ORDER;
  if (scalar === 0n) scalar = 1n;
  return deriveKeypairFromSpendingKey(scalar);
}

export async function deriveNullifierExact(
  spendingKey: Field,
  commitment: Field,
  leafIndex: bigint | number,
): Promise<Field> {
  return poseidon2([spendingKey, commitment, BigInt(leafIndex), NULLIFIER_DOMAIN]);
}

export function encodeShieldedAddress(spendingPk: CurvePoint, viewingPk: CurvePoint): string {
  const spX = fieldToBytes32(spendingPk.x);
  const vpX = fieldToBytes32(viewingPk.x);
  const out = new Uint8Array(66);
  out[0] = Number(spendingPk.y & 1n);
  out.set(spX, 1);
  out[33] = Number(viewingPk.y & 1n);
  out.set(vpX, 34);
  return 'safu1' + base58Encode(out);
}

export interface DecodedShieldedAddress {
  spendingPk: CurvePoint;
  viewingPk: CurvePoint;
}

export function decodeShieldedAddress(addr: string): DecodedShieldedAddress {
  if (!addr.startsWith('safu1')) throw new Error('Bad shielded address prefix');
  const b58 = addr.slice('safu1'.length);
  const out = base58Decode(b58);
  if (out.length !== 66) throw new Error('Bad shielded address length: ' + out.length);

  function parsePoint(parityByte: number, xBytes: Uint8Array): CurvePoint {
    const x = bytes32ToField(xBytes);
    const p = GRUMPKIN_ORDER; // Grumpkin base field = BN254 scalar field = Noir Field prime
    const rhs = (modPow(x, 3n, p) + p - 17n) % p;
    let y = modSqrt(rhs, p);
    if (y === null) throw new Error('Point not on Grumpkin curve');
    if ((Number(y & 1n)) !== (parityByte & 1)) y = p - y;
    return { x, y };
  }

  return {
    spendingPk: parsePoint(out[0]!, out.slice(1, 33)),
    viewingPk:  parsePoint(out[33]!, out.slice(34, 66)),
  };
}

/**
 * Hash a Stellar address string for recipient binding in the withdraw circuit.
 *
 * Encoding: SHA-256 of the G... address string as UTF-8 bytes.
 *   SDK:      sha256(new TextEncoder().encode(address.trim()))
 *   Contract: sha256(addr.to_string().as_bytes())
 *
 * Caller must pass TextEncoder().encode(recipientStellarAddress.trim()).
 * Do NOT pass XDR bytes — the contract uses the plain address string.
 */
export function stellarAddressToHash(xdrBytes: Uint8Array): Field {
  const h = sha256(xdrBytes);
  return bytesToBigInt(h) % GRUMPKIN_ORDER; // must be < Noir Field prime = BN254 scalar field
}

// modular arithmetic for grumpkin point decompression

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modSqrt(a: bigint, p: bigint): bigint | null {
  if (a === 0n) return 0n;
  if (modPow(a, (p - 1n) / 2n, p) !== 1n) return null;
  if (p % 4n === 3n) return modPow(a, (p + 1n) / 4n, p);
  // tonelli-shanks for general case
  let q = p - 1n;
  let s = 0n;
  while (q % 2n === 0n) { q /= 2n; s++; }
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let m = s;
  let c = modPow(z, q, p);
  let t = modPow(a, q, p);
  let r = modPow(a, (q + 1n) / 2n, p);
  while (true) {
    if (t === 0n) return 0n;
    if (t === 1n) return r;
    let i = 1n;
    let tmp = (t * t) % p;
    while (tmp !== 1n) { tmp = (tmp * tmp) % p; i++; }
    const b = modPow(c, modPow(2n, m - i - 1n, p - 1n), p);
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
}
