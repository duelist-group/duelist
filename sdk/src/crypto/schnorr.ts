// sdk/src/crypto/schnorr.ts
// grumpkin schnorr signing and key derivation via barretenberg bb.js 4.x.
// bb.js v3/v4 init pattern:
// const bb = await barretenberg.new({ threads: n })
// (barretenbergsync also available for sync use)
// in v3/v4, barretenbergsync.new() is still the correct sync init.
// ultrahonkbackend is the main proving interface (not circuitprove).

import { BarretenbergSync } from '@aztec/bb.js';
import type { Field } from '../utils/types.js';

export const GRUMPKIN_ORDER =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

export const GRUMPKIN_FIELD =
  0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

let _bb: BarretenbergSync | null = null;

async function getBb(): Promise<BarretenbergSync> {
  if (!_bb) _bb = await BarretenbergSync.new();
  return _bb;
}

function toBuffer(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function fromBuffer(buf: Uint8Array): bigint {
  let n = 0n;
  for (const b of buf) { n = (n << 8n) | BigInt(b); }
  return n;
}

export async function signSchnorr(sk: bigint, message: Uint8Array): Promise<Uint8Array> {
  const bb = await getBb();
  const { s, e } = bb.schnorrConstructSignature({ message, privateKey: toBuffer(sk) });
  const sig = new Uint8Array(64);
  sig.set(s, 0);
  sig.set(e, 32);
  return sig;
}

export async function verifySchnorr(
  pkX: bigint, pkY: bigint, signature: Uint8Array, message: Uint8Array,
): Promise<boolean> {
  const bb = await getBb();
  const result = bb.schnorrVerifySignature({
    message,
    publicKey: { x: toBuffer(pkX), y: toBuffer(pkY) },
    s: signature.slice(0, 32),
    e: signature.slice(32, 64),
  });
  return result.verified;
}

export async function deriveGrumpkinPubkey(sk: bigint): Promise<{ x: bigint; y: bigint }> {
  const bb = await getBb();
  const { publicKey } = bb.schnorrComputePublicKey({ privateKey: toBuffer(sk) });
  return { x: fromBuffer(publicKey.x), y: fromBuffer(publicKey.y) };
}

export async function initBarretenberg(): Promise<void> {
  await getBb();
}

export const GRUMPKIN_GENERATOR = {
  x: 1n,
  y: 0x0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn,
  isInfinity: false,
};
