// sdk/src/crypto/poseidon.ts
// poseidon2 hash via barretenberg bb.js 4.x.
// bb.js v3/v4: barretenbergsync.new() for sync init.
// poseidon2hash returns { hash: uint8array } — same shape across v3/v4.

import { BarretenbergSync } from '@aztec/bb.js';
import type { Field } from '../utils/types.js';

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

export async function poseidon2(inputs: Field[]): Promise<Field> {
  const bb = await getBb();
  const result = bb.poseidon2Hash({ inputs: inputs.map(toBuffer) });
  return fromBuffer(result.hash);
}

export async function initPoseidon(): Promise<void> {
  await getBb();
}
