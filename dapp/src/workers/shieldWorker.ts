// dapp/src/workers/shieldworker.ts
// all wasm and cryptography runs exclusively here.
// the main thread stays clean: zero wasm, zero spending keys.
// message protocol: { id, type, ...args } → { id, ok, result | error }

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, BarretenbergSync, Fr } from '@aztec/bb.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/hashes/utils.js';

// constants

// grumpkin base field = bn254 scalar field = noirs field prime
const GRUMPKIN_ORDER = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const GRUMPKIN_SCALAR = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
// generator point for grumpkin
const G = {
  x: 1n,
  y: 0x0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn,
};
const POOL_DEPTH = 32;
const NONCE_LEN = 12;
const VIEWING_KEY_DOMAIN = 1n;
const NULLIFIER_DOMAIN = 2n;
// F2: anti-dust floor, must match lib_shield::note::MIN_NOTE_VALUE in the circuits.
// change/output amounts below this are folded into the fee instead of minted.
const MIN_NOTE_VALUE = 1000n;

// field helpers

function fmod(a: bigint, p: bigint): bigint {
  const r = a % p;
  return r < 0n ? r + p : r;
}

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
    const lam = fmod(fmod(3n * fmod(x1 * x1, P), P) * finv(fmod(2n * y1, P), P), P);
    const x3 = fmod(lam * lam - x1 - x2, P);
    return [x3, fmod(lam * (x1 - x3) - y1, P), false];
  }
  const lam = fmod(fmod(y2 - y1, P) * finv(fmod(x2 - x1, P), P), P);
  const x3 = fmod(lam * lam - x1 - x2, P);
  return [x3, fmod(lam * (x1 - x3) - y1, P), false];
}

function ptMul(scalar: bigint, px: bigint, py: bigint): { x: bigint; y: bigint } {
  const P = GRUMPKIN_ORDER; // base field
  let s = fmod(scalar, GRUMPKIN_SCALAR); // reduce scalar mod group order
  if (s === 0n) return { x: 0n, y: 0n };
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

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function bytes32ToBigint(buf: Uint8Array): bigint {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

function bigintToHex(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

function hexToBigint(hex: string): bigint {
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

// base58 (for shielded address encoding)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let str = '';
  while (num > 0n) { const rem = num % 58n; num /= 58n; str = B58[Number(rem)] + str; }
  for (const b of bytes) { if (b === 0) str = '1' + str; else break; }
  return str;
}

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const c of str) {
    const idx = B58.indexOf(c);
    if (idx === -1) throw new Error('Invalid Base58 char: ' + c);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  let zeroes = 0;
  for (const c of str) { if (c === '1') zeroes++; else break; }
  const out = new Uint8Array(zeroes + bytes.length);
  out.set(bytes, zeroes);
  return out;
}

// modular arithmetic for point decompression

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = fmod(base, mod);
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
  let q = p - 1n, s = 0n;
  while (q % 2n === 0n) { q /= 2n; s++; }
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let m = s, c = modPow(z, q, p), t = modPow(a, q, p), r = modPow(a, (q + 1n) / 2n, p);
  while (true) {
    if (t === 0n) return 0n;
    if (t === 1n) return r;
    let i = 1n, tmp = (t * t) % p;
    while (tmp !== 1n) { tmp = (tmp * tmp) % p; i++; }
    const b = modPow(c, modPow(2n, m - i - 1n, p - 1n), p);
    m = i; c = (b * b) % p; t = (t * c) % p; r = (r * b) % p;
  }
}

// shielded address encode/decode

function encodeShieldedAddress(spendingPk: { x: bigint; y: bigint }, viewingPk: { x: bigint; y: bigint }): string {
  const spX = bigintToBytes32(spendingPk.x);
  const vpX = bigintToBytes32(viewingPk.x);
  const out = new Uint8Array(66);
  out[0] = Number(spendingPk.y & 1n);
  out.set(spX, 1);
  out[33] = Number(viewingPk.y & 1n);
  out.set(vpX, 34);
  return 'zk1' + base58Encode(out);
}

function decodeShieldedAddress(addr: string): { spendingPk: { x: bigint; y: bigint }; viewingPk: { x: bigint; y: bigint } } {
  if (!addr.startsWith('zk1')) throw new Error('Bad shielded address prefix');
  const out = base58Decode(addr.slice(3));
  if (out.length !== 66) throw new Error('Bad shielded address length');
  const P = GRUMPKIN_ORDER;
  function parsePoint(parityByte: number, xBytes: Uint8Array): { x: bigint; y: bigint } {
    const x = bytes32ToBigint(xBytes);
    const rhs = fmod(modPow(x, 3n, P) - 17n, P);
    let y = modSqrt(rhs, P);
    if (y === null) throw new Error('Point not on Grumpkin curve');
    if (Number(y & 1n) !== (parityByte & 1)) y = P - y;
    return { x, y };
  }
  return {
    spendingPk: parsePoint(out[0], out.slice(1, 33)),
    viewingPk: parsePoint(out[33], out.slice(34, 66)),
  };
}

// barretenberg singleton

let _bbInit: Promise<BarretenbergSync> | null = null;

async function getBb(): Promise<BarretenbergSync> {
  if (_bbInit) return _bbInit;
  _bbInit = BarretenbergSync.initSingleton();
  return _bbInit;
}

// poseidon2

async function poseidon2(inputs: bigint[]): Promise<bigint> {
  const bb = await getBb();
  const result = bb.poseidon2Hash(inputs.map(n => new Fr(n)));
  return bytes32ToBigint(result.toBuffer());
}

// schnorr signature

async function schnorrSign(sk: bigint, message: Uint8Array): Promise<Uint8Array> {
  const bb = await getBb();

  // grumpkin schnorr — must match schnorr.nrs calculate_signature_challenge exactly:
  // r = k*g
  // pde = pedersen_hash([r.x, pk.x, pk.y])
  // ebytes = blake2s(pde || message) ← raw 32 bytes stored in sig[32..64]
  // e_scalar = bytes(ebytes) mod grumpkin_scalar
  // s = k - e_scalar*sk mod grumpkin_scalar
  // sig = s_bytes(32) || ebytes(32)
  const pk = ptMul(sk, G.x, G.y);

  const skBytes = bigintToBytes32(sk);
  const nonceInput = new Uint8Array(32 + message.length);
  nonceInput.set(skBytes, 0);
  nonceInput.set(message, 32);
  let k = bytes32ToBigint(bb.blake2s(nonceInput).buffer) % GRUMPKIN_SCALAR;
  if (k === 0n) k = 1n;

  const R = ptMul(k, G.x, G.y);

  // pedersen_hash([r.x, pk.x, pk.y]) — matches noirs pedersen_hash built-in
  const pde = bb.pedersenHash([new Fr(R.x), new Fr(pk.x), new Fr(pk.y)], 0).toBuffer();
  const hashInput = new Uint8Array(32 + message.length);
  hashInput.set(pde, 0);
  hashInput.set(message, 32);
  const eBytes = bb.blake2s(hashInput).buffer as Uint8Array;

  // e_scalar used for s computation (matches normalize_signature in the circuit)
  const eScalar = bytes32ToBigint(eBytes) % GRUMPKIN_SCALAR;
  const s = fmod(k - fmod(eScalar * sk, GRUMPKIN_SCALAR), GRUMPKIN_SCALAR);

  const sig = new Uint8Array(64);
  sig.set(bigintToBytes32(s), 0);
  sig.set(eBytes, 32); // raw blake2s bytes — circuit compares these directly
  return sig;
}

// incremental merkle tree (inlined from sdk)

let zeroLeaves: bigint[] | null = null;

async function getZeroLeaves(): Promise<bigint[]> {
  if (zeroLeaves) return zeroLeaves;
  const arr: bigint[] = [0n];
  for (let i = 1; i <= POOL_DEPTH; i++) {
    arr.push(await poseidon2([arr[i - 1], arr[i - 1]]));
  }
  zeroLeaves = arr;
  return arr;
}

class IncrementalMerkleTree {
  depth: number;
  leaves: bigint[] = [];
  constructor(depth = POOL_DEPTH) { this.depth = depth; }
  get size() { return this.leaves.length; }
  insert(leaf: bigint): number { const idx = this.leaves.length; this.leaves.push(leaf); return idx; }
  insertBatch(leaves: bigint[]) { for (const l of leaves) this.leaves.push(l); }

  async computeRoot(): Promise<bigint> {
    const zeros = await getZeroLeaves();
    let level = [...this.leaves];
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zeros[lvl];
        next.push(await poseidon2([left, right]));
      }
      if (next.length === 0) next.push(zeros[lvl + 1]);
      level = next;
    }
    return level[0] ?? zeros[this.depth];
  }

  async getProof(leafIndex: number): Promise<{ path: bigint[]; indices: number[] }> {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) throw new Error(`Leaf ${leafIndex} out of range`);
    const zeros = await getZeroLeaves();
    const path: bigint[] = [], indices: number[] = [];
    let level = [...this.leaves], idx = leafIndex;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const isRight = (idx & 1) === 1;
      indices.push(isRight ? 1 : 0);
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      path.push(siblingIdx < level.length ? level[siblingIdx] : zeros[lvl]);
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zeros[lvl];
        next.push(await poseidon2([left, right]));
      }
      if (next.length === 0) next.push(zeros[lvl + 1]);
      level = next;
      idx >>= 1;
    }
    return { path, indices };
  }
}

// note encryption

async function encryptNote(
  note: { ownerPkX: bigint; ownerPkY: bigint; assetId: bigint; amount: bigint; blinding: bigint },
  viewingPk: { x: bigint; y: bigint },
): Promise<{ ciphertext: Uint8Array; ephemeralPk: Uint8Array }> {
  let ephSk: bigint;
  do { ephSk = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR; } while (ephSk === 0n);
  const ephPk = ptMul(ephSk, G.x, G.y);
  const shared = ptMul(ephSk, viewingPk.x, viewingPk.y);
  const key = sha256(bigintToBytes32(shared.x));

  const plaintext = new Uint8Array(80);
  let v = note.amount;
  for (let i = 15; i >= 0; i--) { plaintext[i] = Number(v & 0xffn); v >>= 8n; }
  plaintext.set(bigintToBytes32(note.assetId), 16);
  plaintext.set(bigintToBytes32(note.blinding), 48);

  const nonce = randomBytes(NONCE_LEN);
  const ct = chacha20poly1305(key, nonce).encrypt(plaintext);
  const ciphertext = new Uint8Array(NONCE_LEN + ct.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(ct, NONCE_LEN);

  const ephemeralPk = new Uint8Array(64);
  ephemeralPk.set(bigintToBytes32(ephPk.x), 0);
  ephemeralPk.set(bigintToBytes32(ephPk.y), 32);
  return { ciphertext, ephemeralPk };
}

// note decryption

function tryDecryptNote(
  encrypted: { ciphertext: Uint8Array; ephemeralPk: Uint8Array },
  viewingKey: bigint,
  ownerPkX: bigint,
  ownerPkY: bigint,
): { ownerPkX: bigint; ownerPkY: bigint; assetId: bigint; amount: bigint; blinding: bigint } | null {
  if (encrypted.ephemeralPk.length !== 64) return null;
  if (encrypted.ciphertext.length < NONCE_LEN + 16) return null;
  const ephX = bytes32ToBigint(encrypted.ephemeralPk.slice(0, 32));
  const ephY = bytes32ToBigint(encrypted.ephemeralPk.slice(32, 64));
  const vk = fmod(viewingKey, GRUMPKIN_SCALAR);
  const shared = ptMul(vk === 0n ? 1n : vk, ephX, ephY);
  if (shared.x === 0n && shared.y === 0n) return null;
  const key = sha256(bigintToBytes32(shared.x));
  const nonce = encrypted.ciphertext.slice(0, NONCE_LEN);
  const ct = encrypted.ciphertext.slice(NONCE_LEN);
  try {
    const plaintext = chacha20poly1305(key, nonce).decrypt(ct);
    if (plaintext.length !== 80) return null;
    let amount = 0n;
    for (let i = 0; i < 16; i++) amount = (amount << 8n) | BigInt(plaintext[i]);
    const assetId = bytes32ToBigint(plaintext.slice(16, 48));
    const blinding = bytes32ToBigint(plaintext.slice(48, 80));
    return { ownerPkX, ownerPkY, assetId, amount, blinding };
  } catch {
    return null;
  }
}

// indexer helpers

async function fetchPoolRoot(indexerUrl: string): Promise<bigint> {
  const resp = await fetch(`${indexerUrl}/state`);
  if (!resp.ok) throw new Error(`Indexer /state unavailable (${resp.status}) — cannot fetch pool root`);
  const data = await resp.json() as { root: string };
  return hexToBigint(data.root);
}

async function fetchMerkleProof(indexerUrl: string, leafIndex: number): Promise<{ path: bigint[]; indices: number[] }> {
  const resp = await fetch(`${indexerUrl}/tree/proof/${leafIndex}`);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as any;
    if (body?.error?.includes('out of range')) {
      throw new Error(`Stale wallet state — click the refresh button to re-sync, then retry`);
    }
    throw new Error(`Indexer /tree/proof/${leafIndex} unavailable (${resp.status})`);
  }
  const data = await resp.json() as { path: string[]; indices: number[] };
  return {
    path: data.path.map(hexToBigint),
    indices: data.indices,
  };
}

// circuit cache

type CircuitType = 'deposit' | 'transfer' | 'transfer_batch' | 'withdraw_small' | 'withdraw_large';
const CIRCUIT_URLS: Record<CircuitType, string> = {
  deposit: '/circuits/deposit.json',
  transfer: '/circuits/transfer.json',
  transfer_batch: '/circuits/transfer_batch.json',
  withdraw_small: '/circuits/withdraw_small.json',
  withdraw_large: '/circuits/withdraw_large.json',
};
const circuitCache = new Map<CircuitType, { circuit: any; backend: InstanceType<typeof UltraHonkBackend> }>();

async function getCircuit(type: CircuitType) {
  if (circuitCache.has(type)) return circuitCache.get(type)!;
  const res = await fetch(CIRCUIT_URLS[type]);
  if (!res.ok) throw new Error(`Failed to fetch circuit ${type}: ${res.status}`);
  const circuit = await res.json();
  // Multi-thread only when crossOriginIsolated (SharedArrayBuffer available).
  // In an iOS standalone PWA that isn't isolated, fall back to single-thread so
  // proving still runs (slower) rather than failing to spawn thread workers.
  const isolated = (self as any).crossOriginIsolated === true;
  const threads = isolated
    ? Math.max(1, Math.min(4, Math.floor(((self as any).navigator?.hardwareConcurrency ?? 2) / 2)))
    : 1;
  const backend = new UltraHonkBackend(circuit.bytecode, { threads }, { recursive: false });
  const entry = { circuit, backend };
  circuitCache.set(type, entry);
  return entry;
}

async function generateProof(type: CircuitType, abiInputs: Record<string, any>) {
  const { circuit, backend } = await getCircuit(type);
  const noir = new Noir(circuit);
  const { witness } = await noir.execute(abiInputs);
  // keccak=true: disables zk (456 fields instead of 508) and uses keccak fiat-shamir transcript,
  // which matches the deployed on-chain verifier (built for bb v0.87.0 / nargo beta.9).
  const { proof, publicInputs } = await backend.generateProof(witness, { keccak: true });
  return { proof, publicInputs: publicInputs as string[] };
}

// worker state

interface DiscoveredNote {
  ownerPkX: bigint;
  ownerPkY: bigint;
  assetId: bigint;
  amount: bigint;
  blinding: bigint;
  commitment: bigint;
  nullifier: bigint;
  leafIndex: number;
  spent: boolean;
  origin?: string; // 'deposit' | 'send' | 'withdrawal' | 'payroll' — for POI (deposit-only)
}

interface WorkerState {
  spendingKey: bigint;
  viewingKey: bigint;
  shieldedPk: { x: bigint; y: bigint };
  viewingPk: { x: bigint; y: bigint };
  shieldedAddress: string;
  tree: IncrementalMerkleTree;
  notes: Map<string, DiscoveredNote>; // commitmentHex → note
  spentNullifiers: Set<string>;
  lastSyncedLedger: number;
  indexerUrl: string;
  poolContract: string;
}

let state: WorkerState | null = null;

// note: tx_hash no longer folds in a contract-identity field. it is recomputed
// in-circuit from the public inputs (which include pool_root); pool_root is
// per-deployment so cross-pool replay is already prevented. (F3)

// handlers

async function handleUnlock(msg: { spendingKeyHex: string; indexerUrl: string; poolContract: string }) {
  const sk = hexToBigint(msg.spendingKeyHex);
  if (sk === 0n || sk >= GRUMPKIN_ORDER) throw new Error('Spending key out of range');

  // viewing key: poseidon2([sk, 1n]) — uses barretenbergsync (fine in worker)
  const viewingKey = await poseidon2([sk, VIEWING_KEY_DOMAIN]);
  const vk = viewingKey % GRUMPKIN_SCALAR === 0n ? 1n : viewingKey % GRUMPKIN_SCALAR;

  // public keys: pure js ptmul — no barretenbergsync needed
  const shieldedPk = ptMul(sk, G.x, G.y);
  const viewingPk = ptMul(vk, G.x, G.y);

  const shieldedAddress = encodeShieldedAddress(shieldedPk, viewingPk);

  state = {
    spendingKey: sk,
    viewingKey,
    shieldedPk,
    viewingPk,
    shieldedAddress,
    tree: new IncrementalMerkleTree(POOL_DEPTH),
    notes: new Map(),
    spentNullifiers: new Set(),
    lastSyncedLedger: 0,
    indexerUrl: msg.indexerUrl,
    poolContract: msg.poolContract,
  };

  return {
    shieldedAddress,
    shieldedPkX: bigintToHex(shieldedPk.x),
    shieldedPkY: bigintToHex(shieldedPk.y),
    viewingPkX: bigintToHex(viewingPk.x),
    viewingPkY: bigintToHex(viewingPk.y),
  };
}

async function handleProveDeposit(msg: { assetIdHex: string; grossAmount: string; feeBps: number }) {
  if (!state) throw new Error('Worker not unlocked');
  const assetId = hexToBigint(msg.assetIdHex);
  const grossAmount = BigInt(msg.grossAmount);
  const feeAmount = (grossAmount * BigInt(msg.feeBps)) / 10_000n;
  const netAmount = grossAmount - feeAmount;
  if (netAmount <= 0n) throw new Error('Net amount after fee is non-positive');

  const blinding = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;
  const commitment = await poseidon2([state.shieldedPk.x, state.shieldedPk.y, assetId, netAmount, blinding]);

  const abiInputs = {
    output_commitment: bigintToHex(commitment),
    asset_id: bigintToHex(assetId),
    amount: bigintToHex(netAmount),
    owner_pk_x: bigintToHex(state.shieldedPk.x),
    owner_pk_y: bigintToHex(state.shieldedPk.y),
    blinding: bigintToHex(blinding),
  };

  const { proof, publicInputs } = await generateProof('deposit', abiInputs);

  const { ciphertext, ephemeralPk } = await encryptNote(
    { ownerPkX: state.shieldedPk.x, ownerPkY: state.shieldedPk.y, assetId, amount: netAmount, blinding },
    state.viewingPk,
  );

  return {
    commitment: bigintToHex(commitment),
    netAmount: netAmount.toString(),
    proofBytes: Array.from(proof),
    publicInputs,
    encryptedCiphertext: Array.from(ciphertext),
    encryptedEphemeralPk: Array.from(ephemeralPk),
  };
}

async function handleProveTransfer(msg: {
  recipientAddress: string;
  assetIdHex: string;
  amount: string;
  fee: string;
}) {
  if (!state) throw new Error('Worker not unlocked');

  const assetId = hexToBigint(msg.assetIdHex);
  const amount = BigInt(msg.amount);
  const fee = BigInt(msg.fee);
  const total = amount + fee;

  const decoded = decodeShieldedAddress(msg.recipientAddress);
  const recipientPk = decoded.spendingPk;
  const recipientViewingPk = decoded.viewingPk;

  // select input notes — largest first so a single large note is preferred over two small ones
  const candidates = [...state.notes.values()]
    .filter(n => !n.spent && n.assetId === assetId)
    .sort((a, b) => Number(b.amount - a.amount));

  const inputs: DiscoveredNote[] = [];
  let acc = 0n;
  for (const c of candidates) {
    inputs.push(c);
    acc += c.amount;
    if (acc >= total) break;
    if (inputs.length >= 2) break;
  }
  if (acc < total) throw new Error('Insufficient shielded balance');

  // F2: dust change (below the circuit's MIN_NOTE_VALUE) cannot be minted as a
  // note, so fold it into the fee instead of creating a sub-minimum change note.
  let rawChange = acc - total;
  let effFee = fee;
  if (rawChange > 0n && rawChange < MIN_NOTE_VALUE) {
    effFee += rawChange;
    rawChange = 0n;
  }
  const changeAmount = rawChange;
  const blindingRecipient = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;
  const blindingChange = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;

  const out1Commit = await poseidon2([recipientPk.x, recipientPk.y, assetId, amount, blindingRecipient]);
  const out2Commit = changeAmount > 0n
    ? await poseidon2([state.shieldedPk.x, state.shieldedPk.y, assetId, changeAmount, blindingChange])
    : 0n;

  const null1 = await poseidon2([state.spendingKey, inputs[0].commitment, BigInt(inputs[0].leafIndex), NULLIFIER_DOMAIN]);
  const null2 = inputs[1]
    ? await poseidon2([state.spendingKey, inputs[1].commitment, BigInt(inputs[1].leafIndex), NULLIFIER_DOMAIN])
    : 0n;

  // fetch proof and root from the indexer — the indexer is the single source of
  // truth for the merkle tree and is the same source the relayer uses when it
  // calls submit_new_pool_root. using a locally-computed root risks a mismatch
  // between the proofs pool_root public input and the on-chain stored root.
  const poolRoot = await fetchPoolRoot(state.indexerUrl);
  const proof1 = await fetchMerkleProof(state.indexerUrl, inputs[0].leafIndex);
  const proof2 = inputs[1]
    ? await fetchMerkleProof(state.indexerUrl, inputs[1].leafIndex)
    : { path: Array<bigint>(POOL_DEPTH).fill(0n), indices: Array<number>(POOL_DEPTH).fill(0) };

  // F3: tx_hash preimage must match the circuit (transfer/src/main.nr) exactly:
  // pool_root, nullifier1, nullifier2, out_commitment1, out_commitment2, asset_id, fee.
  const txHash = await poseidon2([poolRoot, null1, null2, out1Commit, out2Commit, assetId, effFee]);
  const txHashBytes = bigintToBytes32(txHash);
  const signature = await schnorrSign(state.spendingKey, txHashBytes);

  const abiInputs = {
    pool_root: bigintToHex(poolRoot),
    nullifier1: bigintToHex(null1),
    nullifier2: bigintToHex(null2),
    output_commitment1: bigintToHex(out1Commit),
    output_commitment2: bigintToHex(out2Commit),
    asset_id: bigintToHex(assetId),
    fee: bigintToHex(effFee),
    tx_hash: bigintToHex(txHash),
    spending_key: bigintToHex(state.spendingKey),
    signature: Array.from(signature).map(String),
    in1_amount: bigintToHex(inputs[0].amount),
    in1_blinding: bigintToHex(inputs[0].blinding),
    in1_index: String(inputs[0].leafIndex),
    in1_path: proof1.path.map(bigintToHex),
    in1_path_indices: proof1.indices.map(String),
    in2_amount: bigintToHex(inputs[1]?.amount ?? 0n),
    in2_blinding: bigintToHex(inputs[1]?.blinding ?? 0n),
    in2_index: String(inputs[1]?.leafIndex ?? 0),
    in2_path: proof2.path.map(bigintToHex),
    in2_path_indices: proof2.indices.map(String),
    out1_owner_pk_x: bigintToHex(recipientPk.x),
    out1_owner_pk_y: bigintToHex(recipientPk.y),
    out1_amount: bigintToHex(amount),
    out1_blinding: bigintToHex(blindingRecipient),
    out2_owner_pk_x: bigintToHex(state.shieldedPk.x),
    out2_owner_pk_y: bigintToHex(state.shieldedPk.y),
    out2_amount: bigintToHex(changeAmount),
    out2_blinding: bigintToHex(blindingChange),
  };

  const { proof, publicInputs } = await generateProof('transfer', abiInputs);

  const encryptedNotes = [
    await encryptNote(
      { ownerPkX: recipientPk.x, ownerPkY: recipientPk.y, assetId, amount, blinding: blindingRecipient },
      recipientViewingPk,
    ),
  ];
  if (changeAmount > 0n) {
    encryptedNotes.push(await encryptNote(
      { ownerPkX: state.shieldedPk.x, ownerPkY: state.shieldedPk.y, assetId, amount: changeAmount, blinding: blindingChange },
      state.viewingPk,
    ));
  }

  // note: do not mark notes as spent here — only on-chain nullifier confirmation
  // (via refresh) is authoritative. optimistic marking caused false "balance gone"
  // when a transaction failed after proof generation.

  return {
    proofBytes: Array.from(proof),
    publicInputs,
    publicData: {
      poolRoot: bigintToHex(poolRoot),
      nullifier1: bigintToHex(null1),
      nullifier2: bigintToHex(null2),
      outputCommitment1: bigintToHex(out1Commit),
      outputCommitment2: bigintToHex(out2Commit),
      assetId: bigintToHex(assetId),
      fee: bigintToHex(fee),
      txHash: bigintToHex(txHash),
    },
    encryptedNotes: encryptedNotes.map(n => ({
      ciphertext: Array.from(n.ciphertext),
      ephemeralPk: Array.from(n.ephemeralPk),
    })),
  };
}

async function handleScan() {
  if (!state) throw new Error('Worker not unlocked');
  if (!state.indexerUrl) return { added: 0, spent: 0, ledger: 0 };

  // fetch new events from indexer — throws if unavailable so caller can show an error.
  const url = `${state.indexerUrl}/events?since=${state.lastSyncedLedger}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Indexer unavailable (${resp.status}) — cannot sync notes`);
  const data = await resp.json();
  const rawEvents: any[] = data.events || [];
  let added = 0, spent = 0, highestLedger = state.lastSyncedLedger;

  // helper: try to decrypt one note slot and add to state if it belongs to us
  async function trySlot(enc: number[] | null, eph: number[] | null, commit: number[] | null, leafIdx: number | null, origin: string) {
    if (!enc || !eph || !commit || leafIdx == null) return;
    const decrypted = tryDecryptNote(
      { ciphertext: new Uint8Array(enc), ephemeralPk: new Uint8Array(eph) },
      state!.viewingKey,
      state!.shieldedPk.x,
      state!.shieldedPk.y,
    );
    if (!decrypted) return;
    const onChainCommitment = bytes32ToBigint(new Uint8Array(commit));
    const expectedCommitment = await poseidon2([
      decrypted.ownerPkX, decrypted.ownerPkY,
      decrypted.assetId, decrypted.amount, decrypted.blinding,
    ]);
    if (expectedCommitment !== onChainCommitment) return;
    const nullifier = await poseidon2([state!.spendingKey, onChainCommitment, BigInt(leafIdx), NULLIFIER_DOMAIN]);
    const key = bigintToHex(onChainCommitment);
    if (!state!.notes.has(key)) {
      state!.notes.set(key, { ...decrypted, commitment: onChainCommitment, leafIndex: leafIdx, nullifier, spent: false, origin });
      added++;
    }
  }

  for (const ev of rawEvents) {
    if (ev.ledger > highestLedger) highestLedger = ev.ledger;

    // process spent nullifiers (indexer normalises nullifiers[] for all event types)
    if (ev.nullifiers) {
      for (const nArr of ev.nullifiers) {
        const nBuf = new Uint8Array(nArr);
        const nf = bytes32ToBigint(nBuf);
        if (nf === 0n) continue;
        const nfHex = bigintToHex(nf);
        state.spentNullifiers.add(nfHex);
        for (const note of state.notes.values()) {
          if (bigintToHex(note.nullifier) === nfHex) { note.spent = true; spent++; }
        }
      }
    }

    if (ev.type === 'deposit') {
      await trySlot(ev.encryptedNote, ev.ephemeralPk, ev.commitment, ev.leafIndex, 'deposit');
    } else if (ev.type === 'transfer') {
      // transfer emits up to two output notes — try both slots
      await trySlot(ev.encryptedNote1, ev.ephemeralPk1, ev.commitment1, ev.leafIndex1, 'send');
      await trySlot(ev.encryptedNote2, ev.ephemeralPk2, ev.commitment2, ev.leafIndex2, 'send');
    } else if (ev.type === 'withdraw' || ev.type === 'xfr_batch') {
      // withdraw emits change + decoy outputs; batch transfer emits up to 12
      // outputs (recipients + change + decoys). the indexer normalises these into
      // a generic `outputs` array so we can scan each slot uniformly.
      if (Array.isArray(ev.outputs)) {
        for (const o of ev.outputs) {
          await trySlot(o.encryptedNote, o.ephemeralPk, o.commitment, o.leafIndex, ev.type === 'xfr_batch' ? 'payroll' : 'withdrawal');
        }
      }
    }
  }

  // rebuild merkle tree from all commitments
  try {
    const url = `${state.indexerUrl}/commitments`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const allCommitments: bigint[] = (data.commitments || []).map((h: string) => BigInt(h));
      state.tree = new IncrementalMerkleTree(POOL_DEPTH);
      state.tree.insertBatch(allCommitments);
    }
  } catch { /* fall back to local-only tree */ }

  state.lastSyncedLedger = highestLedger;
  return { added, spent, ledger: highestLedger };
}

function handleBalances() {
  if (!state) return {};
  const out: Record<string, string> = {};
  for (const note of state.notes.values()) {
    if (note.spent) continue;
    const key = bigintToHex(note.assetId);
    out[key] = ((BigInt(out[key] ?? '0') + note.amount)).toString();
  }
  return out;
}

function handleGetCommitments() {
  if (!state) return {};
  const out: Record<string, { amount: string; assetId: string; spent: boolean }> = {};
  for (const [key, note] of state.notes.entries()) {
    out[key] = { amount: note.amount.toString(), assetId: bigintToHex(note.assetId), spent: note.spent };
  }
  return out;
}

function handleGetNullifierMap(): Record<string, { amount: string; assetId: string }> {
  if (!state) return {};
  const out: Record<string, { amount: string; assetId: string }> = {};
  for (const note of state.notes.values()) {
    out[bigintToHex(note.nullifier)] = { amount: note.amount.toString(), assetId: bigintToHex(note.assetId) };
  }
  return out;
}

// build n input slots: real notes (with merkle proofs) followed by dummy
// zero-value decoy notes (random blinding -> random-looking nullifiers, merkle
// inclusion skipped in-circuit). returns the per-slot witness arrays + the
// public nullifiers. shared by withdraw and batch-transfer.
async function buildInputSlots(N: number, inputs: DiscoveredNote[], assetId: bigint) {
  const inAmounts: bigint[] = [];
  const inBlindings: bigint[] = [];
  const inIndices: bigint[] = [];
  const inPaths: bigint[][] = [];
  const inPathIndices: number[][] = [];
  const nullifiers: bigint[] = [];

  for (let i = 0; i < N; i++) {
    if (i < inputs.length) {
      const note = inputs[i];
      const proof = await fetchMerkleProof(state!.indexerUrl, note.leafIndex);
      inAmounts.push(note.amount);
      inBlindings.push(note.blinding);
      inIndices.push(BigInt(note.leafIndex));
      inPaths.push(proof.path);
      inPathIndices.push(proof.indices);
      nullifiers.push(await poseidon2([state!.spendingKey, note.commitment, BigInt(note.leafIndex), NULLIFIER_DOMAIN]));
    } else {
      // dummy/decoy slot: amount 0, random blinding -> unique commitment & nullifier.
      const dBlind = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;
      const dIndex = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_ORDER;
      const dCommit = await poseidon2([state!.shieldedPk.x, state!.shieldedPk.y, assetId, 0n, dBlind]);
      inAmounts.push(0n);
      inBlindings.push(dBlind);
      inIndices.push(dIndex);
      inPaths.push(Array<bigint>(POOL_DEPTH).fill(0n));
      inPathIndices.push(Array<number>(POOL_DEPTH).fill(0));
      nullifiers.push(await poseidon2([state!.spendingKey, dCommit, dIndex, NULLIFIER_DOMAIN]));
    }
  }
  return { inAmounts, inBlindings, inIndices, inPaths, inPathIndices, nullifiers };
}

// hash a recipient stellar address the same way the pools hash_address does:
// sha256(address string) with the top byte masked to 0 (< field prime).
function hashStellarRecipient(address: string): bigint {
  const recipientHashBuf = sha256(new TextEncoder().encode(address.trim()));
  const masked = new Uint8Array(recipientHashBuf);
  masked[0] = 0;
  return bytesToBigInt(masked);
}

async function handleProveWithdraw(msg: {
  assetIdHex: string;
  recipientStellarAddress: string;
  fee: string;
  withdrawAmount: string;
}) {
  if (!state) throw new Error('Worker not unlocked');

  const assetId = hexToBigint(msg.assetIdHex);
  const fee = BigInt(msg.fee);
  const withdrawAmount = BigInt(msg.withdrawAmount);
  if (withdrawAmount <= 0n) throw new Error('Withdraw amount must be positive');
  const target = withdrawAmount + fee;

  // select the smallest set of notes (largest-first) that covers withdraw + fee.
  const candidates = [...state.notes.values()]
    .filter(n => !n.spent && n.assetId === assetId)
    .sort((a, b) => Number(b.amount - a.amount));

  const inputs: DiscoveredNote[] = [];
  let acc = 0n;
  for (const c of candidates) {
    inputs.push(c);
    acc += c.amount;
    if (acc >= target) break;
  }
  if (acc < target) throw new Error('Insufficient shielded balance for this withdrawal');
  if (inputs.length > 16) throw new Error('This amount spans more than 16 notes — withdraw a smaller amount.');

  // bucket: 4-input circuit if it fits, else 16-input.
  const N = inputs.length <= 4 ? 4 : 16;
  const circuit: CircuitType = N === 4 ? 'withdraw_small' : 'withdraw_large';

  // F2: dust change (below the circuit's MIN_NOTE_VALUE) cannot be minted as a
  // change note, so fold it into the fee. (folding into fee keeps the recipient
  // payout and recipient-hash binding stable; the contract's fee>=min_fee check
  // only ever sees a larger fee, so it stays valid.)
  let rawChange = acc - target;
  let effFee = fee;
  if (rawChange > 0n && rawChange < MIN_NOTE_VALUE) {
    effFee += rawChange;
    rawChange = 0n;
  }
  const changeAmount = rawChange;
  const decoyAmount = 0n;
  const changeBlinding = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;
  const decoyBlinding = bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR;
  const changeCommit = await poseidon2([state.shieldedPk.x, state.shieldedPk.y, assetId, changeAmount, changeBlinding]);
  const decoyCommit = await poseidon2([state.shieldedPk.x, state.shieldedPk.y, assetId, decoyAmount, decoyBlinding]);

  const recipientHash = hashStellarRecipient(msg.recipientStellarAddress);

  const poolRoot = await fetchPoolRoot(state.indexerUrl);
  const slots = await buildInputSlots(N, inputs, assetId);

  // F3: tx_hash preimage must match the circuit (joinsplit::withdraw_main) exactly:
  // pool_root, nullifier_1..n, change_commitment, decoy_commitment,
  // asset_id, withdraw_amount, fee, recipient_stellar_hash.
  const txHash = await poseidon2([
    poolRoot, ...slots.nullifiers, changeCommit, decoyCommit,
    assetId, withdrawAmount, effFee, recipientHash,
  ]);
  const signature = await schnorrSign(state.spendingKey, bigintToBytes32(txHash));

  const abiInputs = {
    pool_root: bigintToHex(poolRoot),
    nullifiers: slots.nullifiers.map(bigintToHex),
    change_commitment: bigintToHex(changeCommit),
    decoy_commitment: bigintToHex(decoyCommit),
    asset_id: bigintToHex(assetId),
    withdraw_amount: bigintToHex(withdrawAmount),
    fee: bigintToHex(effFee),
    recipient_stellar_hash: bigintToHex(recipientHash),
    tx_hash: bigintToHex(txHash),
    spending_key: bigintToHex(state.spendingKey),
    signature: Array.from(signature).map(String),
    in_amounts: slots.inAmounts.map(bigintToHex),
    in_blindings: slots.inBlindings.map(bigintToHex),
    in_indices: slots.inIndices.map(x => x.toString()),
    in_paths: slots.inPaths.map(p => p.map(bigintToHex)),
    in_path_indices: slots.inPathIndices.map(pi => pi.map(String)),
    change_amount: bigintToHex(changeAmount),
    change_blinding: bigintToHex(changeBlinding),
    decoy_amount: bigintToHex(decoyAmount),
    decoy_blinding: bigintToHex(decoyBlinding),
    recipient_address_field: bigintToHex(recipientHash),
  };

  const { proof, publicInputs } = await generateProof(circuit, abiInputs);

  const encChange = await encryptNote(
    { ownerPkX: state.shieldedPk.x, ownerPkY: state.shieldedPk.y, assetId, amount: changeAmount, blinding: changeBlinding },
    state.viewingPk,
  );
  const encDecoy = await encryptNote(
    { ownerPkX: state.shieldedPk.x, ownerPkY: state.shieldedPk.y, assetId, amount: decoyAmount, blinding: decoyBlinding },
    state.viewingPk,
  );

  return {
    proofBytes: Array.from(proof),
    publicInputs,
    publicData: {
      poolRoot: bigintToHex(poolRoot),
      nullifiers: slots.nullifiers.map(bigintToHex),
      changeCommitment: bigintToHex(changeCommit),
      decoyCommitment: bigintToHex(decoyCommit),
      assetId: bigintToHex(assetId),
      withdrawAmount: withdrawAmount.toString(),
      fee: effFee.toString(),
      recipientStellarHash: bigintToHex(recipientHash),
      txHash: bigintToHex(txHash),
    },
    encryptedNoteChange: { ciphertext: Array.from(encChange.ciphertext), ephemeralPk: Array.from(encChange.ephemeralPk) },
    encryptedNoteDecoy: { ciphertext: Array.from(encDecoy.ciphertext), ephemeralPk: Array.from(encDecoy.ephemeralPk) },
  };
}

// batch transfer: pay up to 10 recipients (shielded) in one transaction.
// 16-input / 12-output circuit; unused output slots are zero-value decoys to self.
async function handleProveTransferBatch(msg: {
  recipients: { address: string; amount: string }[];
  assetIdHex: string;
  fee: string;
}) {
  if (!state) throw new Error('Worker not unlocked');

  const assetId = hexToBigint(msg.assetIdHex);
  const fee = BigInt(msg.fee);
  const recips = msg.recipients;
  if (recips.length === 0) throw new Error('No recipients');
  if (recips.length > 10) throw new Error('Max 10 recipients per batch transfer');

  const recipAmounts = recips.map(r => BigInt(r.amount));
  const totalOut = recipAmounts.reduce((s, v) => s + v, 0n);
  const target = totalOut + fee;

  const candidates = [...state.notes.values()]
    .filter(n => !n.spent && n.assetId === assetId)
    .sort((a, b) => Number(b.amount - a.amount));
  const inputs: DiscoveredNote[] = [];
  let acc = 0n;
  for (const c of candidates) {
    inputs.push(c);
    acc += c.amount;
    if (acc >= target) break;
  }
  if (acc < target) throw new Error('Insufficient shielded balance for this batch');
  if (inputs.length > 16) throw new Error('This batch spans more than 16 input notes — reduce amounts or split the batch.');

  const N = 16;
  const M = 12;
  // F2: dust change folds into the fee so no sub-minimum change note is minted.
  let rawChange = acc - target;
  let effFee = fee;
  if (rawChange > 0n && rawChange < MIN_NOTE_VALUE) {
    effFee += rawChange;
    rawChange = 0n;
  }
  const changeAmount = rawChange;

  // build the 12 outputs: recipients, then change (to self), then zero-value decoys (to self).
  const outPkX: bigint[] = [];
  const outPkY: bigint[] = [];
  const outAmounts: bigint[] = [];
  const outBlindings: bigint[] = [];
  const outViewingPk: { x: bigint; y: bigint }[] = [];
  for (let j = 0; j < M; j++) {
    if (j < recips.length) {
      const dec = decodeShieldedAddress(recips[j].address);
      outPkX.push(dec.spendingPk.x);
      outPkY.push(dec.spendingPk.y);
      outAmounts.push(recipAmounts[j]);
      outViewingPk.push(dec.viewingPk);
    } else if (j === recips.length) {
      outPkX.push(state.shieldedPk.x);
      outPkY.push(state.shieldedPk.y);
      outAmounts.push(changeAmount);
      outViewingPk.push(state.viewingPk);
    } else {
      outPkX.push(state.shieldedPk.x);
      outPkY.push(state.shieldedPk.y);
      outAmounts.push(0n);
      outViewingPk.push(state.viewingPk);
    }
    outBlindings.push(bytes32ToBigint(randomBytes(32)) % GRUMPKIN_SCALAR);
  }
  const outCommits: bigint[] = [];
  for (let j = 0; j < M; j++) {
    outCommits.push(await poseidon2([outPkX[j], outPkY[j], assetId, outAmounts[j], outBlindings[j]]));
  }

  const poolRoot = await fetchPoolRoot(state.indexerUrl);
  const slots = await buildInputSlots(N, inputs, assetId);

  // F3: tx_hash preimage must match the circuit (joinsplit::transfer_batch_main):
  // pool_root, nullifier_1..n, out_commitment_1..m, asset_id, fee.
  const txHash = await poseidon2([
    poolRoot, ...slots.nullifiers, ...outCommits, assetId, effFee,
  ]);
  const signature = await schnorrSign(state.spendingKey, bigintToBytes32(txHash));

  const abiInputs = {
    pool_root: bigintToHex(poolRoot),
    nullifiers: slots.nullifiers.map(bigintToHex),
    out_commitments: outCommits.map(bigintToHex),
    asset_id: bigintToHex(assetId),
    fee: bigintToHex(effFee),
    tx_hash: bigintToHex(txHash),
    spending_key: bigintToHex(state.spendingKey),
    signature: Array.from(signature).map(String),
    in_amounts: slots.inAmounts.map(bigintToHex),
    in_blindings: slots.inBlindings.map(bigintToHex),
    in_indices: slots.inIndices.map(x => x.toString()),
    in_paths: slots.inPaths.map(p => p.map(bigintToHex)),
    in_path_indices: slots.inPathIndices.map(pi => pi.map(String)),
    out_pk_x: outPkX.map(bigintToHex),
    out_pk_y: outPkY.map(bigintToHex),
    out_amounts: outAmounts.map(bigintToHex),
    out_blindings: outBlindings.map(bigintToHex),
  };

  const { proof, publicInputs } = await generateProof('transfer_batch', abiInputs);

  const encryptedNotes = [];
  for (let j = 0; j < M; j++) {
    encryptedNotes.push(await encryptNote(
      { ownerPkX: outPkX[j], ownerPkY: outPkY[j], assetId, amount: outAmounts[j], blinding: outBlindings[j] },
      outViewingPk[j],
    ));
  }

  return {
    proofBytes: Array.from(proof),
    publicInputs,
    publicData: {
      poolRoot: bigintToHex(poolRoot),
      nullifiers: slots.nullifiers.map(bigintToHex),
      outCommitments: outCommits.map(bigintToHex),
      assetId: bigintToHex(assetId),
      fee: effFee.toString(),
      txHash: bigintToHex(txHash),
      recipientCount: recips.length,
    },
    encryptedNotes: encryptedNotes.map(n => ({
      ciphertext: Array.from(n.ciphertext),
      ephemeralPk: Array.from(n.ephemeralPk),
    })),
  };
}

function handleGetViewingKey() {
  if (!state) throw new Error('Worker not unlocked');
  return { viewingKey: bigintToHex(state.viewingKey) };
}

async function handleGeneratePOI(msg: { commitmentHex: string; sourceAddress: string }) {
  if (!state) throw new Error('Worker not unlocked');
  const note = state.notes.get(msg.commitmentHex) as any;
  if (!note) throw new Error('Commitment not found in your wallet. Proof of Innocence is for your own DEPOSIT commitments — sync your wallet (refresh) and use a Deposit commitment, not one from a Send or Withdraw.');
  if (note.origin && note.origin !== 'deposit') {
    throw new Error(`Proof of Innocence works for DEPOSIT commitments only. This note came from a ${note.origin} — those funds originated inside the pool, so there is no public deposit source to attest. Use the commitment from your original deposit instead.`);
  }

  const poolRoot = await fetchPoolRoot(state.indexerUrl);
  const blacklistRoot = 0n; // V1: blacklist root not yet on-chain

  const timestamp = Math.floor(Date.now() / 1000);
  const payloadStr = [
    'SHIELD-POI-v1',
    msg.commitmentHex,
    bigintToHex(note.assetId),
    note.amount.toString(),
    note.leafIndex.toString(),
    bigintToHex(poolRoot),
    bigintToHex(blacklistRoot),
    msg.sourceAddress,
    timestamp.toString(),
  ].join('|');

  const payloadBytes = new TextEncoder().encode(payloadStr);
  const attestationHash = sha256(payloadBytes);
  const signature = await schnorrSign(state.spendingKey, attestationHash);

  const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return {
    version: 1,
    commitment: msg.commitmentHex,
    assetId: bigintToHex(note.assetId),
    amount: note.amount.toString(),
    leafIndex: note.leafIndex,
    poolRoot: bigintToHex(poolRoot),
    blacklistRoot: bigintToHex(blacklistRoot),
    sourceAddress: msg.sourceAddress,
    attestationHash: toHex(attestationHash),
    signature: toHex(signature),
    signerPkX: bigintToHex(state.shieldedPk.x),
    signerPkY: bigintToHex(state.shieldedPk.y),
    timestamp,
  };
}

async function handleVerifyPOI(msg: { attestation: string }) {
  let att: any;
  try { att = JSON.parse(msg.attestation); } catch { throw new Error('Invalid attestation JSON'); }

  const { commitment, assetId, amount, leafIndex, poolRoot, blacklistRoot, sourceAddress, timestamp, attestationHash, signature, signerPkX, signerPkY } = att;

  const payloadStr = [
    'SHIELD-POI-v1', commitment, assetId, amount.toString(), leafIndex.toString(),
    poolRoot, blacklistRoot, sourceAddress, timestamp.toString(),
  ].join('|');
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const expectedHash = sha256(payloadBytes);
  const expectedHashHex = Array.from(expectedHash).map((x: number) => x.toString(16).padStart(2, '0')).join('');
  if (expectedHashHex !== attestationHash) throw new Error('Attestation hash mismatch');

  // schnorr verify: sig = s(32) || ebytes(32)
  const sigBytes = new Uint8Array(signature.match(/.{2}/g)!.map((h: string) => parseInt(h, 16)));
  const hashBytes = new Uint8Array(attestationHash.match(/.{2}/g)!.map((h: string) => parseInt(h, 16)));
  if (sigBytes.length !== 64 || hashBytes.length !== 32) throw new Error('Bad signature format');

  const s = bytes32ToBigint(sigBytes.slice(0, 32));
  const eBytes = sigBytes.slice(32, 64);
  const eScalar = bytes32ToBigint(eBytes) % GRUMPKIN_SCALAR;

  const pkX = hexToBigint(signerPkX);
  const pkY = hexToBigint(signerPkY);

  // r = g*s + pk*e
  const Gs = ptMul(s, G.x, G.y);
  const PKe = ptMul(eScalar, pkX, pkY);
  const [rx, , rinf] = ptAdd(Gs.x, Gs.y, false, PKe.x, PKe.y, false, GRUMPKIN_ORDER);
  if (rinf) return { valid: false };

  const bb = await getBb();
  const pde = bb.pedersenHash([new Fr(rx), new Fr(pkX), new Fr(pkY)], 0).toBuffer();
  const hashInput = new Uint8Array(32 + hashBytes.length);
  hashInput.set(pde, 0);
  hashInput.set(hashBytes, 32);
  const computedEBytes = bb.blake2s(hashInput).buffer as Uint8Array;

  const valid = computedEBytes.every((b, i) => b === eBytes[i]);
  return { valid, signerPkX, signerPkY };
}

function handleLock() {
  state = null;
  zeroLeaves = null;
  circuitCache.clear();
  return null;
}

// message dispatcher

self.onmessage = async (event: MessageEvent) => {
  const { id, type, ...args } = event.data;
  try {
    let result: any;
    switch (type) {
      // Compile the Barretenberg WASM up-front (off the main thread) so the first
      // poseidon2 — which runs inside `unlock` at Derive time — is instant. Fired on
      // worker boot, it overlaps with the user connecting their wallet, so the Derive
      // click no longer pays the ~10 MB WASM compile.
      case 'prewarm':        await getBb(); result = { ok: true };              break;
      case 'unlock':         result = await handleUnlock(args as any);         break;
      case 'prove_deposit':  result = await handleProveDeposit(args as any);   break;
      case 'prove_transfer': result = await handleProveTransfer(args as any);  break;
      case 'prove_transfer_batch': result = await handleProveTransferBatch(args as any); break;
      case 'prove_withdraw': result = await handleProveWithdraw(args as any);  break;
      case 'scan':           result = await handleScan();                       break;
      case 'balances':       result = handleBalances();                         break;
      case 'get_commitments':   result = handleGetCommitments();                  break;
      case 'get_nullifier_map': result = handleGetNullifierMap();                break;
      case 'get_root':          result = { root: state ? bigintToHex(await state.tree.computeRoot()) : '0x' + '0'.repeat(64) }; break;
      case 'get_viewing_key': result = handleGetViewingKey();                    break;
      case 'generate_poi':   result = await handleGeneratePOI(args as any);    break;
      case 'verify_poi':     result = await handleVerifyPOI(args as any);      break;
      case 'lock':           result = handleLock();                             break;
      default: throw new Error(`Unknown message type: ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
