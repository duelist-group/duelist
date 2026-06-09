// indexer/src/server.ts
// shield protocol — global state indexer.
// important: the merkle tree uses barretenbergs poseidon2 via @aztec/bb.js,
// not poseidon-lite. poseidon-lite implements the original poseidon (2019),
// while barretenberg and the circuits use poseidon2 (2023) — different
// algorithms with different round constants. using poseidon-lite would produce
// wrong roots that never match the on-chain state.
// endpoints:
// get /state → { root, commitmentcount, lastledger }
// get /commitments → { commitments: hex[] }
// get /tree/proof/:index → { path: hex[], indices: number[] }
// get /nullifier/:hash → { spent: boolean }
// get /events?since=n → { events: rawevent[] }
// get /health → { ok, commitments, lastledger }

import express from 'express';
import { rpc, xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { BarretenbergSync } from '@aztec/bb.js';
import fs from 'fs';
import path from 'path';

// config

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const POOL_CONTRACT = process.env.POOL_CONTRACT || '';
const PORT = parseInt(process.env.PORT || '3001', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);
const POOL_DEPTH = 32;

if (!POOL_CONTRACT) {
  console.error('ERROR: Set POOL_CONTRACT env var');
  process.exit(1);
}

// barretenberg poseidon2 (must match circuit + sdk)

let _bb: BarretenbergSync | null = null;

async function getBb(): Promise<BarretenbergSync> {
  if (!_bb) _bb = await BarretenbergSync.new();
  return _bb;
}

function toBuffer32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function fromBuffer(buf: Uint8Array): bigint {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

async function poseidon2bb(inputs: bigint[]): Promise<bigint> {
  const bb = await getBb();
  const result = bb.poseidon2Hash({ inputs: inputs.map(toBuffer32) });
  return fromBuffer(result.hash);
}

// merkle tree
// all async because barretenberg poseidon2 is async.

let ZERO_HASHES: bigint[] | null = null;

async function getZeroHashes(): Promise<bigint[]> {
  if (ZERO_HASHES) return ZERO_HASHES;
  const arr: bigint[] = [0n];
  for (let i = 1; i <= POOL_DEPTH; i++) {
    const prev = arr[i - 1]!;
    arr.push(await poseidon2bb([prev, prev]));
  }
  ZERO_HASHES = arr;
  return arr;
}

class MerkleTree {
  leaves: bigint[] = [];

  get size(): number { return this.leaves.length; }

  insert(leaf: bigint) { this.leaves.push(leaf); }

  async root(): Promise<bigint> {
    const zeros = await getZeroHashes();
    let level = [...this.leaves];
    for (let lvl = 0; lvl < POOL_DEPTH; lvl++) {
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : zeros[lvl]!;
        next.push(await poseidon2bb([left, right]));
      }
      if (next.length === 0) next.push(zeros[lvl + 1]!);
      level = next;
    }
    return level[0] ?? (await getZeroHashes())[POOL_DEPTH]!;
  }

  async proof(leafIndex: number): Promise<{ path: string[]; indices: number[] }> {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of range (size=${this.leaves.length})`);
    }
    const zeros = await getZeroHashes();
    const path: bigint[] = [];
    const indices: number[] = [];
    let level = [...this.leaves];
    let idx = leafIndex;

    for (let lvl = 0; lvl < POOL_DEPTH; lvl++) {
      const isRight = (idx & 1) === 1;
      indices.push(isRight ? 1 : 0);
      const sibIdx = isRight ? idx - 1 : idx + 1;
      path.push(sibIdx < level.length ? level[sibIdx]! : zeros[lvl]!);

      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : zeros[lvl]!;
        next.push(await poseidon2bb([left, right]));
      }
      if (next.length === 0) next.push(zeros[lvl + 1]!);
      level = next;
      idx >>= 1;
    }

    return {
      path: path.map(f => '0x' + f.toString(16).padStart(64, '0')),
      indices,
    };
  }
}

// state

const tree = new MerkleTree();
const nullifiers = new Set<string>();
const rawEvents: any[] = [];
let lastLedger = 0;
let cursor: string | undefined;

// event persistence

const EVENTS_FILE = path.join(process.cwd(), 'events.json');

function loadPersistedEvents(): void {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8'));
    if (Array.isArray(data.events)) {
      for (const ev of data.events) {
        rawEvents.push(ev);
        if (ev._id) seenEventIds.add(ev._id);
        // populate nullifier set from persisted events
        if (ev.nullifiers) {
          for (const nf of ev.nullifiers) {
            nullifiers.add('0x' + Buffer.from(nf).toString('hex').padStart(64, '0'));
          }
        }
      }
      if (typeof data.lastLedger === 'number' && data.lastLedger > lastLedger) {
        lastLedger = data.lastLedger;
      }
      if (data.cursor) cursor = data.cursor;
      console.log(`Loaded ${data.events.length} persisted events (last ledger: ${lastLedger})`);
    }
  } catch (e: any) {
    console.warn('Could not load persisted events:', e.message);
  }
}

function persistEvents(): void {
  try {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events: rawEvents, lastLedger, cursor }));
  } catch (e: any) {
    console.warn('Could not persist events:', e.message);
  }
}

// hex helpers

function toHex(val: Uint8Array | Buffer): bigint {
  return BigInt('0x' + Buffer.from(val).toString('hex').padStart(64, '0'));
}

// event parsing

// updatetree=false during backfill (tree already populated from contract storage).
function parseEvent(ev: any, ledger: number, updateTree = true): void {
  try {
    const topics = ev.topic?.map((t: any) => scValToNative(t));
    const type = topics?.[0] as string;
    const body = scValToNative(ev.value);

    const txHash: string | undefined = ev.txHash ?? undefined;

    if (type === 'deposit') {
      const commit = toHex(body.commitment);
      if (updateTree) tree.insert(commit);
      rawEvents.push({
        _id: ev.id, ledger, txHash, type,
        commitment: Array.from(body.commitment),
        leafIndex: Number(body.leaf_index),
        encryptedNote: Array.from(body.encrypted_note),
        ephemeralPk: Array.from(body.ephemeral_pk),
        nullifiers: [],
      });
    } else if (type === 'transfer') {
      const c1 = toHex(body.commitment1);
      const c2 = toHex(body.commitment2);
      const n1 = toHex(body.nullifier1);
      const n2 = toHex(body.nullifier2);

      if (updateTree) { tree.insert(c1); if (c2 !== 0n) tree.insert(c2); }
      nullifiers.add('0x' + n1.toString(16).padStart(64, '0'));
      if (n2 !== 0n) nullifiers.add('0x' + n2.toString(16).padStart(64, '0'));

      rawEvents.push({
        _id: ev.id, ledger, txHash, type,
        commitment1: Array.from(body.commitment1),
        commitment2: c2 !== 0n ? Array.from(body.commitment2) : null,
        leafIndex1: Number(body.leaf_index1),
        leafIndex2: c2 !== 0n ? Number(body.leaf_index2) : null,
        encryptedNote1: Array.from(body.encrypted_note1),
        encryptedNote2: c2 !== 0n ? Array.from(body.encrypted_note2) : null,
        ephemeralPk1: Array.from(body.ephemeral_pk1),
        ephemeralPk2: c2 !== 0n ? Array.from(body.ephemeral_pk2) : null,
        nullifiers: [Array.from(body.nullifier1), ...(n2 !== 0n ? [Array.from(body.nullifier2)] : [])],
      });
    } else if (type === 'withdraw') {
      // multi-input withdraw: burns n nullifiers, appends change + decoy outputs.
      const nfs: any[] = body.nullifiers ?? [];
      for (const nf of nfs) {
        const n = toHex(nf);
        if (n !== 0n) nullifiers.add('0x' + n.toString(16).padStart(64, '0'));
      }
      // append change then decoy, matching the contracts append order.
      if (updateTree) {
        tree.insert(toHex(body.change_commitment));
        tree.insert(toHex(body.decoy_commitment));
      }
      rawEvents.push({
        _id: ev.id, ledger, txHash, type,
        nullifiers: nfs.map((n: any) => Array.from(n)),
        outputs: [
          {
            commitment: Array.from(body.change_commitment),
            leafIndex: Number(body.change_leaf_index),
            encryptedNote: Array.from(body.encrypted_note_change),
            ephemeralPk: Array.from(body.ephemeral_pk_change),
          },
          {
            commitment: Array.from(body.decoy_commitment),
            leafIndex: Number(body.decoy_leaf_index),
            encryptedNote: Array.from(body.encrypted_note_decoy),
            ephemeralPk: Array.from(body.ephemeral_pk_decoy),
          },
        ],
      });
    } else if (type === 'xfr_batch') {
      // batch transfer: burns 16 nullifiers, appends 12 output commitments.
      const nfs: any[] = body.nullifiers ?? [];
      for (const nf of nfs) {
        const n = toHex(nf);
        if (n !== 0n) nullifiers.add('0x' + n.toString(16).padStart(64, '0'));
      }
      const commits: any[] = body.commitments ?? [];
      const leafIdxs: any[] = body.leaf_indices ?? [];
      const encNotes: any[] = body.encrypted_notes ?? [];
      const ephPks: any[] = body.ephemeral_pks ?? [];
      if (updateTree) {
        for (const c of commits) tree.insert(toHex(c));
      }
      rawEvents.push({
        _id: ev.id, ledger, txHash, type,
        nullifiers: nfs.map((n: any) => Array.from(n)),
        outputs: commits.map((c: any, i: number) => ({
          commitment: Array.from(c),
          leafIndex: Number(leafIdxs[i]),
          encryptedNote: Array.from(encNotes[i]),
          ephemeralPk: Array.from(ephPks[i]),
        })),
      });
    }
  } catch (e) {
    console.warn(`Failed to parse ${ev.topic} event at ledger ${ledger}:`, e);
  }
}

// poller

const sorobanRpc = new rpc.Server(RPC_URL);

// track processed event ids to prevent duplicates when re-polling the same ledger.
const seenEventIds = new Set<string>();

async function backfillFromContract(): Promise<void> {
  try {
    // read contract instance storage to find commitmentcount.
    const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: Address.fromString(POOL_CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    const instanceResp = await sorobanRpc.getLedgerEntries(instanceKey);
    if (!instanceResp.entries?.[0]) return;

    const storage = instanceResp.entries[0].val.contractData().val().instance().storage();
    if (!storage) return;

    let count = 0;
    for (const entry of storage) {
      const key = scValToNative(entry.key()) as any;
      if (Array.isArray(key) && key[0] === 'CommitmentCount') {
        count = Number(scValToNative(entry.val()));
        break;
      }
    }
    if (count === 0) return;
    console.log(`Backfilling ${count} historical commitments from contract storage...`);

    // read each commitment: persistkey::commitment(i) = vec([symbol("commitment"), u32(i)])
    const BATCH = 30;
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(start + BATCH, count);
      const keys: xdr.LedgerKey[] = [];
      const indices: number[] = [];
      for (let i = start; i < end; i++) {
        keys.push(xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
          contract: Address.fromString(POOL_CONTRACT).toScAddress(),
          key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Commitment'), xdr.ScVal.scvU32(i)]),
          durability: xdr.ContractDataDurability.persistent(),
        })));
        indices.push(i);
      }
      const resp = await sorobanRpc.getLedgerEntries(...keys);
      // sort entries by their index in the keys array to preserve insertion order.
      const sorted = [...(resp.entries ?? [])].sort((a, b) => {
        const aVec = a.key.contractData().key().vec() ?? [];
        const bVec = b.key.contractData().key().vec() ?? [];
        return (aVec[1]?.u32() ?? 0) - (bVec[1]?.u32() ?? 0);
      });
      for (const entry of sorted) {
        const commitment = scValToNative(entry.val.contractData().val()) as Uint8Array;
        tree.insert(toHex(commitment));
      }
    }
    console.log(`Backfill complete: ${tree.size} commitments loaded`);
  } catch (e: any) {
    console.warn('Backfill failed (will rely on event polling):', e.message);
  }

  // backfill historical events so note discovery works after a page refresh.
  try {
    const latest = await sorobanRpc.getLatestLedger();
    // use the full testnet retention window (~17280 ledgers = 24h).
    const lookback = Math.max(1, latest.sequence - 17280);
    let histCursor: string | undefined;
    let histLedger = lookback;
    let fetched = 0;

    while (true) {
      const params: any = {
        filters: [{ type: 'contract', contractIds: [POOL_CONTRACT] }],
        limit: 200,
      };
      if (histCursor) { params.cursor = histCursor; }
      else { params.startLedger = histLedger; }

      const resp = await sorobanRpc.getEvents(params);
      const evs = resp.events ?? [];
      for (const ev of evs) {
        if (seenEventIds.has(ev.id)) continue;
        seenEventIds.add(ev.id);
        parseEvent(ev, ev.ledger, false); // tree already populated from storage
        if (ev.ledger > lastLedger) lastLedger = ev.ledger;
        fetched++;
      }
      if (resp.cursor) histCursor = resp.cursor;
      // stop when weve consumed all available events up to now.
      if (evs.length < 200) break;
    }
    if (fetched > 0) {
      console.log(`Event backfill: ${fetched} historical events ingested`);
      persistEvents();
    }
    // advance poll cursor past what we just fetched so the live poller starts fresh.
    if (histCursor) cursor = histCursor;
  } catch (e: any) {
    console.warn('Event backfill failed:', e.message);
  }
}

async function poll(): Promise<void> {
  try {
    if (lastLedger === 0) {
      const latest = await sorobanRpc.getLatestLedger();
      lastLedger = latest.sequence;
      console.log(`Polling from ledger ${lastLedger}`);
    }

    const params: any = {
      filters: [{ type: 'contract', contractIds: [POOL_CONTRACT] }],
      limit: 200,
    };
    if (cursor) {
      params.cursor = cursor;
    } else {
      params.startLedger = lastLedger;
    }

    const resp = await sorobanRpc.getEvents(params);
    let processed = 0;
    for (const ev of resp.events ?? []) {
      if (seenEventIds.has(ev.id)) continue;
      seenEventIds.add(ev.id);
      parseEvent(ev, ev.ledger);
      if (ev.ledger > lastLedger) lastLedger = ev.ledger;
      processed++;
    }
    // advance cursor so next poll continues from here without overlap.
    if (resp.cursor) cursor = resp.cursor;
    else if (processed > 0) lastLedger += 1;
    if (processed > 0) persistEvents();
  } catch (e: any) {
    const msg: string = e.message ?? '';
    if (msg.includes('start is before oldest') || msg.includes('startledger must be positive')) {
      console.warn('Pruned ledger — resetting to latest');
      const latest = await sorobanRpc.getLatestLedger();
      lastLedger = latest.sequence;
      cursor = undefined;
    } else {
      console.warn('Poll error:', msg || e);
    }
  }
}

// http api

const app = express();

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// simple per-ip rate limit
const rl = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
    ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const e = rl.get(ip);
  if (!e || now > e.resetAt) { rl.set(ip, { count: 1, resetAt: now + 60_000 }); return next(); }
  if (e.count >= 60) { res.status(429).json({ error: 'Rate limit: 60/min' }); return; }
  e.count++;
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, commitments: tree.size, lastLedger });
});

app.get('/state', async (_req, res) => {
  try {
    const root = await tree.root();
    res.json({ root: '0x' + root.toString(16).padStart(64, '0'), commitmentCount: tree.size, lastLedger });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/commitments', (_req, res) => {
  res.json({ commitments: tree.leaves.map(f => '0x' + f.toString(16).padStart(64, '0')) });
});

app.get('/tree/proof/:index', async (req, res) => {
  try {
    const idx = parseInt(req.params.index!, 10);
    res.json(await tree.proof(idx));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/nullifier/:hash', (req, res) => {
  res.json({ spent: nullifiers.has(req.params.hash!.toLowerCase()) });
});

app.get('/events', (req, res) => {
  const since = parseInt((req.query.since as string) || '0', 10);
  res.json({ events: rawEvents.filter(e => e.ledger > since) });
});

// ---- price proxy (cached) ----
// The dapp fetches prices from HERE instead of calling CoinGecko/Binance directly.
// Why: (1) reliability — one cached upstream call serves every user, so CoinGecko's
// per-IP rate-limit can't blank the "total value"; (2) privacy — keeps CoinGecko/Binance
// off the user's browser (no IP / "uses a Stellar wallet" leak). Serves stale on error.
type PriceCacheEntry = { at: number; body: any };
const PRICE_TTL_MS = 60_000;          // current price: 60s
const HIST_TTL_MS = 5 * 60_000;       // history: 5min
let priceNowCache: PriceCacheEntry | null = null;
const histCache = new Map<string, PriceCacheEntry>();

app.get('/price', async (req, res) => {
  const vs = String(req.query.vs || 'usd').replace(/[^a-z,]/gi, '');
  try {
    if (priceNowCache && Date.now() - priceNowCache.at < PRICE_TTL_MS) return res.json(priceNowCache.body);
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=${encodeURIComponent(vs)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('coingecko ' + r.status);
    const body = await r.json();
    priceNowCache = { at: Date.now(), body };
    res.json(body);
  } catch {
    if (priceNowCache) return res.json(priceNowCache.body); // stale-on-error
    res.status(502).json({ error: 'price upstream unavailable' });
  }
});

app.get('/price/history', async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(String(req.query.days || '1'), 10) || 1));
  const vs = String(req.query.vs || 'usd').replace(/[^a-z]/gi, '');
  const key = `${days}-${vs}`;
  try {
    const c = histCache.get(key);
    if (c && Date.now() - c.at < HIST_TTL_MS) return res.json(c.body);
    let prices: [number, number][];
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/stellar/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${days}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('coingecko ' + r.status);
      const d: any = await r.json();
      if (!Array.isArray(d.prices) || !d.prices.length) throw new Error('empty');
      prices = d.prices;
    } catch {
      const pair = ({ usd: 'XLMUSDT', eur: 'XLMEUR', gbp: 'XLMGBP' } as Record<string, string>)[vs];
      if (!pair) throw new Error('no fallback pair');
      const iv = ({ 1: ['1h', 25], 7: ['4h', 43], 30: ['1d', 31] } as Record<number, [string, number]>)[days] || ['1h', 25];
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${iv[0]}&limit=${iv[1]}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('binance ' + r.status);
      const d: any[][] = await r.json();
      prices = d.map(k => [k[0] as number, parseFloat(k[4] as string)]);
    }
    const body = { prices };
    histCache.set(key, { at: Date.now(), body });
    res.json(body);
  } catch {
    const c = histCache.get(key);
    if (c) return res.json(c.body); // stale-on-error
    res.status(502).json({ error: 'history upstream unavailable' });
  }
});

// start

async function validateCacheOrPurge(): Promise<void> {
  if (rawEvents.length === 0) return;
  try {
    const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: Address.fromString(POOL_CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    const instanceResp = await sorobanRpc.getLedgerEntries(instanceKey);
    if (!instanceResp.entries?.[0]) return;
    const storage = instanceResp.entries[0].val.contractData().val().instance().storage();
    if (!storage) return;
    let onChainCount = 0;
    for (const entry of storage) {
      const key = scValToNative(entry.key()) as any;
      if (Array.isArray(key) && key[0] === 'CommitmentCount') {
        onChainCount = Number(scValToNative(entry.val()));
        break;
      }
    }
    // Find the max leaf index referenced in cached events
    let maxCachedIdx = -1;
    for (const ev of rawEvents) {
      const idxs = [ev.leafIndex, ev.leafIndex1, ev.leafIndex2].filter((x: any) => typeof x === 'number');
      for (const idx of idxs) if (idx > maxCachedIdx) maxCachedIdx = idx;
    }
    if (maxCachedIdx >= onChainCount) {
      console.warn(`Stale cache detected: events reference leaf ${maxCachedIdx} but pool only has ${onChainCount} commitments. Purging events.json and rebuilding.`);
      rawEvents.length = 0;
      seenEventIds.clear();
      nullifiers.clear();
      lastLedger = 0;
      cursor = undefined;
      if (fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
    }
  } catch (e: any) {
    console.warn('Could not validate cache against on-chain state:', e.message);
  }
}

async function main() {
  // pre-warm barretenberg wasm and compute zero hashes before starting http.
  console.log('Initializing Barretenberg WASM...');
  await getBb();
  await getZeroHashes();
  console.log('Barretenberg ready.');

  loadPersistedEvents();
  await validateCacheOrPurge();
  await backfillFromContract();

  app.listen(PORT, () => {
    console.log(`Shield Indexer on http://localhost:${PORT}`);
    console.log(`  Pool:    ${POOL_CONTRACT}`);
    console.log(`  RPC:     ${RPC_URL}`);
    console.log(`  Poll:    every ${POLL_INTERVAL}ms`);
    console.log(`  Poseidon2: Barretenberg (matches circuit + SDK)`);
  });

  setInterval(poll, POLL_INTERVAL);
  await poll();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
