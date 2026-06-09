// sdk/src/utils/encoding.ts

import { GRUMPKIN_SCALAR_ORDER, type Field, type Hex } from './types.js';

// noirs field prime = bn254 scalar field = grumpkin base field = grumpkin_scalar_order.
const FIELD_PRIME = GRUMPKIN_SCALAR_ORDER;

export function fieldToBytes32(f: Field): Uint8Array {
  if (f < 0n || f >= FIELD_PRIME) {
    throw new Error(`Field out of range [0, FIELD_PRIME): ${f}`);
  }
  const out = new Uint8Array(32);
  let v = f;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Convert a byte array to a BigInt (big-endian). */
export function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < b.length; i++) {
    v = (v << 8n) | BigInt(b[i]!);
  }
  return v;
}

/** Convert a 32-byte big-endian array to a Field.
 *  Throws if the value is >= Noir's field prime (BN254 scalar field). */
export function bytes32ToField(b: Uint8Array): Field {
  if (b.length !== 32) throw new Error('Expected 32 bytes');
  const v = bytesToBigInt(b);
  if (v >= FIELD_PRIME) {
    throw new Error(`Bytes overflow Field prime: ${v.toString(16)}`);
  }
  return v;
}

/** Convert hex string (with or without 0x) to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error('Hex length must be even');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Convert Uint8Array to 0x-prefixed hex string. */
export function bytesToHex(b: Uint8Array): Hex {
  let s = '0x';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s as Hex;
}

/** Convert a Field to 0x-prefixed 32-byte hex string. */
export function fieldToHex(f: Field): Hex {
  return bytesToHex(fieldToBytes32(f));
}

/** Convert hex string to Field. */
export function hexToField(hex: Hex | string): Field {
  return bytes32ToField(hexToBytes(hex));
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let str = '';
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    str = B58_ALPHABET[Number(rem)] + str;
  }
  for (const b of bytes) {
    if (b === 0) str = '1' + str;
    else break;
  }
  return str;
}

export function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const c of str) {
    const idx = B58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error('Invalid Base58 character: ' + c);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  let zeroes = 0;
  for (const c of str) {
    if (c === '1') zeroes++;
    else break;
  }
  const out = new Uint8Array(zeroes + bytes.length);
  out.set(bytes, zeroes);
  return out;
}
