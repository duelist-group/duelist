// sdk/src/crypto/noteencryption.ts
// note encryption — ecdh on grumpkin + chacha20-poly1305 aead.
// uses barretenberg wasm for grumpkin point multiplication (ecdh),
// eliminating the duplicated js point arithmetic from the previous version.

import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  deriveGrumpkinPubkey,
  GRUMPKIN_ORDER,
} from './schnorr.js';
import { fieldToBytes32, bytes32ToField } from '../utils/encoding.js';
import type { Field, CurvePoint, Note } from '../utils/types.js';

const NONCE_LENGTH = 12;

// minimal grumpkin point arithmetic for ecdh only
// this is not used for schnorr signing or key derivation (those use barretenberg).
// its only used for the ecdh shared secret computation which happens off-circuit.

const GRUMPKIN_FIELD = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

function fmod(a: bigint, p: bigint): bigint { const r = a % p; return r < 0n ? r + p : r; }
function finv(a: bigint, p: bigint): bigint {
  if (a === 0n) throw new Error('Cannot invert zero');
  let [old_r, r] = [fmod(a, p), p];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return fmod(old_s, p);
}

function ptMul(scalar: bigint, px: bigint, py: bigint): { x: bigint; y: bigint } {
  const P = GRUMPKIN_FIELD;
  let s = fmod(scalar, GRUMPKIN_ORDER);
  if (s === 0n) return { x: 0n, y: 0n };
  
  // double-and-add on grumpkin (y² = x³ - 17)
  let rx = 0n, ry = 0n, rinf = true;
  let bx = px, by = py, binf = false;
  
  while (s > 0n) {
    if (s & 1n) {
      if (rinf) { rx = bx; ry = by; rinf = false; }
      else { [rx, ry, rinf] = ptAdd(rx, ry, false, bx, by, false, P); }
    }
    [bx, by, binf] = ptAdd(bx, by, binf, bx, by, binf, P);
    s >>= 1n;
  }
  return { x: rx, y: ry };
}

function ptAdd(
  x1: bigint, y1: bigint, inf1: boolean,
  x2: bigint, y2: bigint, inf2: boolean,
  P: bigint,
): [bigint, bigint, boolean] {
  if (inf1) return [x2, y2, inf2];
  if (inf2) return [x1, y1, inf1];
  if (x1 === x2) {
    if (y1 !== y2) return [0n, 0n, true];
    if (y1 === 0n) return [0n, 0n, true];
    const num = fmod(3n * fmod(x1 * x1, P), P);
    const den = finv(fmod(2n * y1, P), P);
    const lam = fmod(num * den, P);
    const x3 = fmod(lam * lam - x1 - x2, P);
    const y3 = fmod(lam * (x1 - x3) - y1, P);
    return [x3, y3, false];
  }
  const lam = fmod(fmod(y2 - y1, P) * finv(fmod(x2 - x1, P), P), P);
  const x3 = fmod(lam * lam - x1 - x2, P);
  const y3 = fmod(lam * (x1 - x3) - y1, P);
  return [x3, y3, false];
}

// note serialization

function serializeNote(note: Note): Uint8Array {
  const out = new Uint8Array(80);
  let v = note.amount;
  for (let i = 15; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  out.set(fieldToBytes32(note.assetId), 16);
  out.set(fieldToBytes32(note.blinding), 48);
  return out;
}

function deserializeNote(pt: Uint8Array, ownerPkX: Field, ownerPkY: Field): Note {
  if (pt.length !== 80) throw new Error('Bad plaintext length');
  let amount = 0n;
  for (let i = 0; i < 16; i++) amount = (amount << 8n) | BigInt(pt[i]!);
  const assetId = bytes32ToField(pt.slice(16, 48));
  const blinding = bytes32ToField(pt.slice(48, 80));
  return { ownerPkX, ownerPkY, assetId, amount, blinding };
}

// public api

export interface EncryptedNote {
  ciphertext: Uint8Array;  // 12-byte nonce || ciphertext(80 + 16 MAC)
  ephemeralPk: Uint8Array; // 64 bytes: X(32 BE) || Y(32 BE)
}

export async function encryptNote(note: Note, recipientViewingPk: CurvePoint): Promise<EncryptedNote> {
  // 1. ephemeral keypair on grumpkin
  let ephSk: bigint;
  do {
    ephSk = bytes32ToField(randomBytes(32)) % GRUMPKIN_ORDER;
  } while (ephSk === 0n);
  const ephPk = await deriveGrumpkinPubkey(ephSk);

  // 2. ecdh shared secret (ephsk * recipientviewingpk)
  const shared = ptMul(ephSk, recipientViewingPk.x, recipientViewingPk.y);
  const key = sha256(fieldToBytes32(shared.x));

  // 3. encrypt
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = chacha20poly1305(key, nonce);
  const plaintext = serializeNote(note);
  const ct = cipher.encrypt(plaintext);

  const out = new Uint8Array(NONCE_LENGTH + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LENGTH);

  const ephPkBytes = new Uint8Array(64);
  ephPkBytes.set(fieldToBytes32(ephPk.x), 0);
  ephPkBytes.set(fieldToBytes32(ephPk.y), 32);

  return { ciphertext: out, ephemeralPk: ephPkBytes };
}

export function tryDecryptNote(
  encrypted: EncryptedNote,
  recipientViewingKey: Field,
  ownerPkX: Field,
  ownerPkY: Field,
): Note | null {
  if (encrypted.ephemeralPk.length !== 64) return null;
  if (encrypted.ciphertext.length < NONCE_LENGTH + 16) return null;

  const ephX = bytes32ToField(encrypted.ephemeralPk.slice(0, 32));
  const ephY = bytes32ToField(encrypted.ephemeralPk.slice(32, 64));

  // ecdh: shared = viewing_key * eph_pk
  const vk = recipientViewingKey % GRUMPKIN_ORDER;
  const shared = ptMul(vk === 0n ? 1n : vk, ephX, ephY);
  if (shared.x === 0n && shared.y === 0n) return null;
  const key = sha256(fieldToBytes32(shared.x));

  const nonce = encrypted.ciphertext.slice(0, NONCE_LENGTH);
  const ct = encrypted.ciphertext.slice(NONCE_LENGTH);

  try {
    const cipher = chacha20poly1305(key, nonce);
    const plaintext = cipher.decrypt(ct);
    return deserializeNote(plaintext, ownerPkX, ownerPkY);
  } catch {
    return null;
  }
}
