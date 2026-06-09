// relayer/src/server.ts
// shield protocol — permissionless relayer
// this service does one thing: take a fully-formed proof + public inputs
// from an arbitrary client, build a soroban transaction calling the pool
// contract, sign it with the relayers stellar key (which only pays fees),
// submit it.
// what this relayer does not do (intentional, per the decentralization plan):
// no witness generation. the users browser proves locally with bb.js.
// no ofac screening. that moved on-chain into the compliance contract.
// no attestation signing. the ultrahonk verifier is fully trustless.
// no special privileges. anyone can run a relayer; the user picks one or
// self-relays. the contract verifies everything — a rogue relayer cannot
// forge or censor a proof.
// all the relayer earns is whatever `fee` field is encoded in the proof.

import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import {
  Keypair, TransactionBuilder, Contract, rpc, BASE_FEE,
  xdr, nativeToScVal, SorobanDataBuilder, Operation, Asset,
} from '@stellar/stellar-sdk';

// config
const RPC_URL = process.env.RPC_URL || '';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || '';
const POOL_CONTRACT = process.env.POOL_CONTRACT || '';
const RELAYER_SECRET = process.env.RELAYER_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3001';
const PORT = parseInt(process.env.PORT || '3002', 10);
const KEEPALIVE_CONTRACTS = [
  POOL_CONTRACT,
  process.env.VERIFIER_CONTRACT,
  process.env.COMPLIANCE_CONTRACT,
  process.env.ENGINE_DEPOSIT,
  process.env.ENGINE_TRANSFER,
  process.env.ENGINE_TRANSFER_BATCH,
  process.env.ENGINE_WITHDRAW_SMALL,
  process.env.ENGINE_WITHDRAW_LARGE,
  process.env.USDC_CONTRACT,
  process.env.EURC_CONTRACT,
  process.env.XLM_CONTRACT,
].filter(Boolean) as string[];
// keepalive runs on a short cycle (default 6h) and only PAYS when an entry has
// drifted below the safety floor — so it can never reach the expensive "near
// expiry" cliff, and it wastes no fees re-extending healthy entries. on a fresh
// restart after downtime it checks everything immediately and auto-pays whatever
// is overdue (restoreFootprint revives even fully-archived entries).
const KEEPALIVE_INTERVAL_MS = parseInt(process.env.KEEPALIVE_INTERVAL_HOURS || '6', 10) * 60 * 60 * 1000;
const LEDGERS_PER_DAY = 17_280;                         // ~5s ledgers
// refill whenever an entry has fewer than this many ledgers left (~60 days).
// far above the danger zone, so a bump is always cheap; far below max, so we
// only act when it actually matters.
const TTL_FLOOR_LEDGERS = parseInt(process.env.TTL_FLOOR_DAYS || '60', 10) * LEDGERS_PER_DAY;

// last keepalive snapshot, surfaced on /health for monitoring/alerting.
type TtlStatus = { contract: string; instanceDays: number | null; codeDays: number | null; healthy: boolean };
let lastKeepalive: { at: string | null; ranOk: boolean; status: TtlStatus[]; error?: string } = {
  at: null, ranOk: false, status: [],
};

// minimum fee the relayer will accept — must match what the pool contract enforces on-chain.
// relay fee floor: 10_000_000 stroops (1.0 token units for 7-decimal tokens).
// chosen for self-sufficiency: the relayer fronts ~0.1-0.15 XLM of network gas per
// tx and is reimbursed from this fee, so the floor sits well above gas with margin
// to absorb xlm price swings and cross-asset friction (fee collected in the
// transacted asset, gas paid in xlm). MUST equal the dapp RELAY_FEE constants and
// the on-chain relay_fee_min (set via set_fee_bps).
// withdraw protocol fee: 25 bps (0.25%) of withdraw_amount, added on top
const MIN_RELAY_FEE = 10_000_000n;
const WITHDRAW_FEE_BPS = 25n;

if (!RPC_URL || !NETWORK_PASSPHRASE || !POOL_CONTRACT || !RELAYER_SECRET) {
  console.error('Required env vars: RPC_URL, NETWORK_PASSPHRASE, POOL_CONTRACT, RELAYER_SECRET');
  process.exit(1);
}

const relayerKeypair = Keypair.fromSecret(RELAYER_SECRET);
const adminKeypair = ADMIN_SECRET ? Keypair.fromSecret(ADMIN_SECRET) : null;
const server = new rpc.Server(RPC_URL);

// ── metabolism: the self-funding treasury loop ──────────────────────────────
// the relayer account is the "metabolic hub": it collects relay fees and pays
// network gas. the admin account is the "healer": it pays contract rent. each
// cycle the loop (1) refuels the healer if it is low, then (2) skims surplus XLM
// above a working buffer to a cold treasury. net effect after deploy: usage fees
// keep the system alive and the profit accrues to treasury with no manual
// top-ups — as long as fee income exceeds upkeep.
//
// HONEST SCOPE: this automates the *finances*, not the hosting. an off-chain
// process (this relayer) must run to submit the rent/skim transactions — soroban
// contracts cannot pay their own rent. it is "self-funding", not "serverless".
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';        // cold wallet — receives profit
// working buffer the relayer keeps for gas (XLM). surplus above this is skimmed.
const RELAYER_BUFFER_XLM = parseFloat(process.env.RELAYER_BUFFER_XLM || '50');
// keep the healer (admin) account topped to at least this much XLM for rent.
const HEALER_MIN_XLM = parseFloat(process.env.HEALER_MIN_XLM || '50');
const HEALER_REFUEL_TO_XLM = parseFloat(process.env.HEALER_REFUEL_TO_XLM || '100');
// only skim/refuel when amounts exceed this, to avoid dust transactions.
const MIN_SWEEP_XLM = parseFloat(process.env.MIN_SWEEP_XLM || '10');
const STROOPS = 10_000_000; // 1 XLM
const RESERVE_XLM = 1.0;    // stellar base reserve that can never be moved

// Treasury skim runs at most once per SKIM_INTERVAL (default WEEKLY) — DECOUPLED
// from the frequent rent keepalive. This keeps the cold treasury's on-chain trail
// coarse (occasional lumps, not a per-tx correlation surface) while rent is still
// checked/topped every tick. Persisted to a file so restarts don't reset the cadence.
const SKIM_INTERVAL_MS = parseInt(process.env.SKIM_INTERVAL_HOURS || '168', 10) * 60 * 60 * 1000;
const SKIM_STATE_FILE = process.env.SKIM_STATE_FILE || './.skim-state.json';
let lastSkimAt: number = (() => {
  try { return JSON.parse(readFileSync(SKIM_STATE_FILE, 'utf-8')).lastSkimAt || 0; } catch { return 0; }
})();

// last metabolism snapshot, surfaced on /health.
let lastMetabolism: {
  at: string | null; healerXlm: number | null; relayerXlm: number | null;
  refueled: number; skimmed: number; treasury: string | null; note?: string;
} = { at: null, healerXlm: null, relayerXlm: null, refueled: 0, skimmed: 0, treasury: TREASURY_ADDRESS || null };

// http
const app = express();
app.use(express.json({ limit: '1mb' }));

// cors: open. anyone is meant to call this.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  next();
});

// tiny per-ip rate limit. soft dos protection only — not gating.
const rl = new Map<string, { count: number; resetAt: number }>();
function rateLimit(maxPerMin: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const entry = rl.get(key);
    if (!entry || now > entry.resetAt) {
      rl.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    if (entry.count >= maxPerMin) {
      res.status(429).json({ error: `Rate limit: max ${maxPerMin}/min` });
      return;
    }
    entry.count++;
    next();
  };
}

// health — includes contract-rent (TTL) status so monitoring can alert before
// anything ever drifts toward the expensive zone. `rentHealthy` is the single
// flag to page on: false means a contract is below the safety floor and the
// auto-healer either hasn't caught up yet or has no admin key to pay.
app.get('/health', (_req, res) => {
  const rentHealthy = lastKeepalive.at != null && lastKeepalive.ranOk;
  res.status(rentHealthy || lastKeepalive.at == null ? 200 : 503).json({
    ok: true,
    relayer: relayerKeypair.publicKey(),
    pool: POOL_CONTRACT,
    rpc: RPC_URL,
    network: NETWORK_PASSPHRASE,
    permissionless: true,
    rent: {
      healthy: rentHealthy,
      lastCheck: lastKeepalive.at,
      floorDays: Math.round(TTL_FLOOR_LEDGERS / LEDGERS_PER_DAY),
      autoHealEnabled: !!ADMIN_SECRET,
      contracts: lastKeepalive.status,
      ...(lastKeepalive.error ? { error: lastKeepalive.error } : {}),
    },
    // the self-funding loop: fees → healer (rent) → surplus → treasury (profit).
    metabolism: {
      lastRun: lastMetabolism.at,
      relayerXlm: lastMetabolism.relayerXlm,
      healerXlm: lastMetabolism.healerXlm,
      lastRefueledXlm: lastMetabolism.refueled,
      lastSkimmedXlm: lastMetabolism.skimmed,
      treasury: lastMetabolism.treasury,
      selfFunding: !!(TREASURY_ADDRESS && ADMIN_SECRET),
      ...(lastMetabolism.note ? { note: lastMetabolism.note } : {}),
    },
  });
});

// manual trigger for the full organism tick (heal + metabolize).
app.post('/metabolize', rateLimit(4), async (_req, res) => {
  if (!adminKeypair && !TREASURY_ADDRESS) {
    return res.status(503).json({ error: 'metabolism disabled (need ADMIN_SECRET and/or TREASURY_ADDRESS)' });
  }
  organismTick().catch(e => console.error('[organism] manual run error:', e));
  res.json({ ok: true, message: 'organism tick triggered (heal + metabolize)' });
});

// manual trigger — kick a keepalive/heal pass on demand (e.g. from a cron ping
// or right before a demo). safe to call anytime; it only pays what is overdue.
app.post('/keepalive', rateLimit(4), async (_req, res) => {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'auto-heal disabled (no ADMIN_SECRET)' });
  keepAliveAll().catch(e => console.error('[keepalive] manual run error:', e));
  res.json({ ok: true, message: 'keepalive triggered', lastCheck: lastKeepalive.at });
});

// helpers
const hexToBuf = (h: string) =>
  Buffer.from(h.replace(/^0x/, '').padStart(64, '0'), 'hex');

// submit a pre-signed user deposit
// deposits require the depositors own auth (to transfer tokens to the pool),
// so the *user* must sign the tx. the relayer only forwards. this is the
// only relay path where theres any user signature in the loop — for
// transfer/withdraw, the spending key authorizes via the zk proof, so the
// relayer signs the outer tx.
app.post('/relay/deposit', rateLimit(20), async (req, res) => {
  try {
    const { signedTxXdr } = req.body;
    if (!signedTxXdr) return res.status(400).json({ error: 'Missing signedTxXdr' });

    const tx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
    const sendResp = await server.sendTransaction(tx);
    res.json({ hash: sendResp.hash, status: sendResp.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// submit a transfer (shielded → shielded)
// all inputs are proofs and public scalars that the contract validates. the
// relayer signs the outer tx (pays the fee) but cannot mutate anything.
app.post('/relay/transfer', rateLimit(20), async (req, res) => {
  try {
    const {
      proof, poolRoot, nullifier1, nullifier2,
      outputCommitment1, outputCommitment2,
      assetId, fee, txHash,
      encryptedNote1, encryptedNote2,
      ephemeralPk1, ephemeralPk2,
    } = req.body;

    if (!proof || !poolRoot || !nullifier1 || !nullifier2 ||
        !outputCommitment1 || !outputCommitment2 || !assetId || fee == null || !txHash ||
        !encryptedNote1 || !ephemeralPk1) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // enforce relay fee floor before touching the network.
    // the zk proof commits to this exact fee — the relayer cannot alter it.
    // a client that proved fee=0 would pay nothing; we reject such requests here.
    const feeBig = BigInt(fee);
    if (feeBig < MIN_RELAY_FEE) {
      return res.status(400).json({ error: `Fee too low: minimum ${MIN_RELAY_FEE} stroops` });
    }

    const account = await server.getAccount(relayerKeypair.publicKey());
    const contract = new Contract(POOL_CONTRACT);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'transfer',
          nativeToScVal(relayerKeypair.publicKey(), { type: 'address' }),
          xdr.ScVal.scvBytes(Buffer.from(proof, 'hex')),
          xdr.ScVal.scvBytes(hexToBuf(poolRoot)),
          xdr.ScVal.scvBytes(hexToBuf(nullifier1)),
          xdr.ScVal.scvBytes(hexToBuf(nullifier2)),
          xdr.ScVal.scvBytes(hexToBuf(outputCommitment1)),
          xdr.ScVal.scvBytes(hexToBuf(outputCommitment2)),
          xdr.ScVal.scvBytes(hexToBuf(assetId)),
          nativeToScVal(BigInt(fee), { type: 'i128' }),
          xdr.ScVal.scvBytes(hexToBuf(txHash)),
          xdr.ScVal.scvBytes(Buffer.from(encryptedNote1, 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(encryptedNote2 || '00'.repeat(96), 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(ephemeralPk1, 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(ephemeralPk2 || '00'.repeat(64), 'hex')),
        ),
      )
      .setTimeout(60)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(relayerKeypair);
    const sendResp = await server.sendTransaction(prepared);

    res.json({ hash: sendResp.hash, status: sendResp.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// submit a withdraw (shielded → public address)
app.post('/relay/withdraw', rateLimit(20), async (req, res) => {
  try {
    const {
      proof, poolRoot, nullifiers, changeCommitment, decoyCommitment, assetId,
      withdrawAmount, fee, recipient, recipientStellarHash, txHash,
      encryptedNoteChange, encryptedNoteDecoy, ephemeralPkChange, ephemeralPkDecoy,
    } = req.body;

    if (!proof || !poolRoot || !Array.isArray(nullifiers) ||
        !changeCommitment || !decoyCommitment || !assetId ||
        withdrawAmount == null || fee == null || !recipient || !recipientStellarHash || !txHash ||
        !encryptedNoteChange || !encryptedNoteDecoy || !ephemeralPkChange || !ephemeralPkDecoy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (nullifiers.length !== 4 && nullifiers.length !== 16) {
      return res.status(400).json({ error: 'nullifiers must have length 4 or 16' });
    }

    // enforce relay fee + protocol fee floor. the pool contract does the same check
    // on-chain (defense in depth) — rejecting here saves a failed soroban call.
    const feeBig = BigInt(fee);
    const withdrawBig = BigInt(withdrawAmount);
    const protocolFee = (withdrawBig * WITHDRAW_FEE_BPS) / 10_000n; // floor, matches contract
    const minFee = MIN_RELAY_FEE + protocolFee;
    if (feeBig < minFee) {
      return res.status(400).json({ error: `Fee too low: minimum ${minFee} stroops (relay + 0.25% protocol fee)` });
    }

    const account = await server.getAccount(relayerKeypair.publicKey());
    const contract = new Contract(POOL_CONTRACT);

    const nullifiersScVal = xdr.ScVal.scvVec(
      nullifiers.map((n: string) => xdr.ScVal.scvBytes(hexToBuf(n))),
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'withdraw',
          nativeToScVal(relayerKeypair.publicKey(), { type: 'address' }),
          xdr.ScVal.scvBytes(Buffer.from(proof, 'hex')),
          xdr.ScVal.scvBytes(hexToBuf(poolRoot)),
          nullifiersScVal,
          xdr.ScVal.scvBytes(hexToBuf(changeCommitment)),
          xdr.ScVal.scvBytes(hexToBuf(decoyCommitment)),
          xdr.ScVal.scvBytes(hexToBuf(assetId)),
          nativeToScVal(withdrawBig, { type: 'i128' }),
          nativeToScVal(feeBig, { type: 'i128' }),
          nativeToScVal(recipient, { type: 'address' }),
          xdr.ScVal.scvBytes(hexToBuf(recipientStellarHash)),
          xdr.ScVal.scvBytes(hexToBuf(txHash)),
          xdr.ScVal.scvBytes(Buffer.from(encryptedNoteChange, 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(encryptedNoteDecoy, 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(ephemeralPkChange, 'hex')),
          xdr.ScVal.scvBytes(Buffer.from(ephemeralPkDecoy, 'hex')),
        ),
      )
      .setTimeout(60)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(relayerKeypair);
    const sendResp = await server.sendTransaction(prepared);

    res.json({ hash: sendResp.hash, status: sendResp.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// submit a batch transfer (shielded → many shielded recipients, one tx)
app.post('/relay/transfer-batch', rateLimit(20), async (req, res) => {
  try {
    const {
      proof, poolRoot, nullifiers, outCommitments,
      assetId, fee, txHash, encryptedNotes, ephemeralPks,
    } = req.body;

    if (!proof || !poolRoot || !Array.isArray(nullifiers) || !Array.isArray(outCommitments) ||
        !assetId || fee == null || !txHash ||
        !Array.isArray(encryptedNotes) || !Array.isArray(ephemeralPks)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (nullifiers.length !== 16 || outCommitments.length !== 12 ||
        encryptedNotes.length !== 12 || ephemeralPks.length !== 12) {
      return res.status(400).json({ error: 'batch: expected 16 nullifiers and 12 outputs' });
    }

    const feeBig = BigInt(fee);
    if (feeBig < MIN_RELAY_FEE) {
      return res.status(400).json({ error: `Fee too low: minimum ${MIN_RELAY_FEE} stroops` });
    }

    const account = await server.getAccount(relayerKeypair.publicKey());
    const contract = new Contract(POOL_CONTRACT);

    const nullifiersScVal = xdr.ScVal.scvVec(
      nullifiers.map((n: string) => xdr.ScVal.scvBytes(hexToBuf(n))),
    );
    const outCommitmentsScVal = xdr.ScVal.scvVec(
      outCommitments.map((c: string) => xdr.ScVal.scvBytes(hexToBuf(c))),
    );
    const encNotesScVal = xdr.ScVal.scvVec(
      encryptedNotes.map((e: string) => xdr.ScVal.scvBytes(Buffer.from(e, 'hex'))),
    );
    const ephPksScVal = xdr.ScVal.scvVec(
      ephemeralPks.map((e: string) => xdr.ScVal.scvBytes(Buffer.from(e, 'hex'))),
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'transfer_batch',
          nativeToScVal(relayerKeypair.publicKey(), { type: 'address' }),
          xdr.ScVal.scvBytes(Buffer.from(proof, 'hex')),
          xdr.ScVal.scvBytes(hexToBuf(poolRoot)),
          nullifiersScVal,
          outCommitmentsScVal,
          xdr.ScVal.scvBytes(hexToBuf(assetId)),
          nativeToScVal(feeBig, { type: 'i128' }),
          xdr.ScVal.scvBytes(hexToBuf(txHash)),
          encNotesScVal,
          ephPksScVal,
        ),
      )
      .setTimeout(60)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(relayerKeypair);
    const sendResp = await server.sendTransaction(prepared);

    res.json({ hash: sendResp.hash, status: sendResp.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// submit a pool root update (admin only, called after deposits)
// fetches the current merkle root from the indexer and submits it on-chain.
// the admin keypair must be configured via admin_secret env var.
app.post('/relay/update-root', rateLimit(10), async (req, res) => {
  try {
    if (!adminKeypair) {
      return res.status(503).json({ error: 'Root updates not configured (ADMIN_SECRET not set)' });
    }

    // fetch the current root from the indexer.
    const stateResp = await fetch(`${INDEXER_URL}/state`);
    if (!stateResp.ok) return res.status(502).json({ error: 'Indexer unavailable' });
    const { root } = await stateResp.json() as { root: string };
    const rootBytes = Buffer.from(root.replace(/^0x/, ''), 'hex');
    if (rootBytes.length !== 32) return res.status(400).json({ error: 'Invalid root from indexer' });

    const account = await server.getAccount(adminKeypair.publicKey());
    const contract = new Contract(POOL_CONTRACT);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'submit_new_pool_root',
          nativeToScVal(adminKeypair.publicKey(), { type: 'address' }),
          xdr.ScVal.scvBytes(rootBytes),
        ),
      )
      .setTimeout(60)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(adminKeypair);
    const sendResp = await server.sendTransaction(prepared);

    res.json({ hash: sendResp.hash, status: sendResp.status, root });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// contract keep-alive
//
// CRITICAL: a Soroban contract is kept alive by TWO ledger entries, and BOTH
// must be topped up or invocations get expensive then break:
//   1. the contract INSTANCE entry (per contract id) — storage + wasm pointer
//   2. the contract CODE (wasm) entry (per wasm hash) — the executable itself
// the original keepalive only bumped (1). when (2) decayed toward expiry, every
// deposit had to pay the wasm rent itself (observed: a single deposit quoted ~47
// XLM with the code entry ~4 days from archival). bumping BOTH on every run, all
// the way to the network max TTL window, keeps invocations at their ~0.07 XLM
// floor permanently — the entries are always refilled long before they get
// costly. extendTo is a TTL WINDOW (ledgers from now), capped at MAX_ENTRY_TTL.
const MAX_TTL_LEDGERS = 3_110_400 - 1; // just under the soroban network max (~180 days)

// read an entry's remaining TTL (ledgers from now). null = entry not found.
// negative = already expired/archived (will need a restore).
async function entryTtlRemaining(key: xdr.LedgerKey, latestLedger: number): Promise<number | null> {
  try {
    const r = await server.getLedgerEntries(key);
    const e = r.entries?.[0];
    if (!e || e.liveUntilLedgerSeq == null) return null;
    return e.liveUntilLedgerSeq - latestLedger;
  } catch { return null; }
}

// extend a set of keys to max TTL, restoring first if needed. only called when
// the entry is actually below the floor (or archived), so we never waste fees.
async function extendKeys(label: string, keys: xdr.LedgerKey[], remaining: number | null): Promise<void> {
  if (!adminKeypair) return;
  // if archived/expired (remaining <= 0 or unknown), restore first.
  if (remaining == null || remaining <= 0) {
    try {
      const acct = await server.getAccount(adminKeypair.publicKey());
      const restoreTx = new TransactionBuilder(acct, { fee: '20000000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.restoreFootprint({}))
        .setSorobanData(new SorobanDataBuilder().setReadWrite(keys).build())
        .setTimeout(60).build();
      const preparedRestore = await server.prepareTransaction(restoreTx);
      preparedRestore.sign(adminKeypair);
      const restoreResp = await server.sendTransaction(preparedRestore);
      if (restoreResp.status !== 'ERROR') {
        console.log(`[keepalive] restored ${label}: ${restoreResp.hash}`);
        await new Promise(r => setTimeout(r, 8000));
      }
    } catch (_) { /* may not be archived — continue to extend */ }
  }

  const acct = await server.getAccount(adminKeypair.publicKey());
  const extendTx = new TransactionBuilder(acct, { fee: '60000000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.extendFootprintTtl({ extendTo: MAX_TTL_LEDGERS }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
    .setTimeout(60).build();
  const preparedExtend = await server.prepareTransaction(extendTx);
  preparedExtend.sign(adminKeypair);
  const extendResp = await server.sendTransaction(preparedExtend);
  console.log(`[keepalive] extended ${label}: ${extendResp.hash} (status ${extendResp.status})`);
}

// check one contract's instance + code TTL; refill only what is below the floor.
// returns the post-check status for /health.
async function bumpContractTtl(contractId: string, latestLedger: number): Promise<TtlStatus> {
  const addr = new Contract(contractId).address().toScAddress();
  const short = contractId.slice(0, 8) + '…';

  // (1) instance entry
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: addr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  let instRem = await entryTtlRemaining(instanceKey, latestLedger);
  if (adminKeypair && (instRem == null || instRem < TTL_FLOOR_LEDGERS)) {
    await extendKeys(`${short}(instance)`, [instanceKey], instRem);
    instRem = MAX_TTL_LEDGERS; // post-extend
  }

  // (2) contract code (wasm) entry — only wasm-backed contracts have one
  // (built-in SAC tokens share network-maintained code, so skip them).
  let codeRem: number | null = null;
  try {
    const instEntries = await server.getLedgerEntries(instanceKey);
    const entry = instEntries.entries?.[0];
    if (entry) {
      const exec = entry.val.contractData().val().instance().executable();
      if (exec.switch().name === 'contractExecutableWasm') {
        const codeKey = xdr.LedgerKey.contractCode(
          new xdr.LedgerKeyContractCode({ hash: exec.wasmHash() }),
        );
        codeRem = await entryTtlRemaining(codeKey, latestLedger);
        if (adminKeypair && (codeRem == null || codeRem < TTL_FLOOR_LEDGERS)) {
          await extendKeys(`${short}(code)`, [codeKey], codeRem);
          codeRem = MAX_TTL_LEDGERS;
        }
      }
    }
  } catch (e: any) {
    console.error(`[keepalive] code-entry check failed for ${short}:`, e?.message ?? e);
  }

  const toDays = (x: number | null) => x == null ? null : Math.round(x / LEDGERS_PER_DAY);
  // healthy = both entries (that exist) are above the floor after this pass.
  const healthy = (instRem == null || instRem >= TTL_FLOOR_LEDGERS) &&
                  (codeRem == null || codeRem >= TTL_FLOOR_LEDGERS);
  return { contract: contractId, instanceDays: toDays(instRem), codeDays: toDays(codeRem), healthy };
}

async function keepAliveAll(): Promise<void> {
  if (!adminKeypair) {
    console.log('[keepalive] no ADMIN_SECRET — skipping (read-only relayer; cannot auto-pay rent)');
    lastKeepalive = { at: new Date().toISOString(), ranOk: false, status: [], error: 'no ADMIN_SECRET' };
    return;
  }
  try {
    const latest = (await server.getLatestLedger()).sequence;
    console.log(`[keepalive] checking ${KEEPALIVE_CONTRACTS.length} contracts (floor ${Math.round(TTL_FLOOR_LEDGERS / LEDGERS_PER_DAY)}d)…`);
    const status: TtlStatus[] = [];
    for (const id of KEEPALIVE_CONTRACTS) {
      try {
        status.push(await bumpContractTtl(id, latest));
      } catch (e: any) {
        console.error(`[keepalive] failed for ${id.slice(0, 8)}…:`, e?.message ?? e);
        status.push({ contract: id, instanceDays: null, codeDays: null, healthy: false });
      }
    }
    const allHealthy = status.every(s => s.healthy);
    lastKeepalive = { at: new Date().toISOString(), ranOk: allHealthy, status };
    console.log(`[keepalive] done — ${allHealthy ? 'all healthy' : 'SOME UNHEALTHY (see /health)'}.`);
  } catch (e: any) {
    console.error('[keepalive] run failed:', e?.message ?? e);
    lastKeepalive = { at: new Date().toISOString(), ranOk: false, status: lastKeepalive.status, error: e?.message ?? String(e) };
  }
}

// native XLM balance of an account, in XLM (0 if unfunded).
async function xlmBalance(pub: string): Promise<number> {
  try {
    const acct: any = await server.getAccount(pub);
    // soroban rpc getAccount returns sequence only; use horizon-style balances via rpc account entry.
    // fall back to the classic account balances endpoint shape if present.
    if (acct?.balances) {
      const native = acct.balances.find((b: any) => b.asset_type === 'native');
      return native ? parseFloat(native.balance) : 0;
    }
  } catch { /* not funded or rpc shape differs */ }
  // robust path: query horizon for the native balance.
  try {
    const horizon = RPC_URL.includes('testnet')
      ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org';
    const r = await fetch(`${horizon}/accounts/${pub}`);
    if (!r.ok) return 0;
    const j: any = await r.json();
    const native = (j.balances ?? []).find((b: any) => b.asset_type === 'native');
    return native ? parseFloat(native.balance) : 0;
  } catch { return 0; }
}

// send native XLM from a given source keypair to a destination (payment op).
async function sendXlm(from: Keypair, toPub: string, amountXlm: number, memo: string): Promise<string | null> {
  const amount = Math.floor(amountXlm * STROOPS) / STROOPS;
  if (amount < 0.0000001) return null;
  const acct = await server.getAccount(from.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: toPub, asset: Asset.native(), amount: amount.toFixed(7) }))
    .setTimeout(60).build();
  tx.sign(from);
  const resp = await server.sendTransaction(tx);
  console.log(`[metabolism] ${memo}: sent ${amount} XLM → ${toPub.slice(0, 8)}… (${resp.status} ${resp.hash})`);
  return resp.status === 'ERROR' ? null : resp.hash;
}

// the self-funding loop. CORRECT money flow: relay + protocol fees land in the
// on-chain `fee_recipient`, which is the ADMIN/HEALER account (the same key that
// pays rent). so the HEALER is the metabolic hub. each cycle, signed by the admin
// key, it: (1) keeps a rent buffer for itself, (2) refuels the RELAYER's gas
// account if that has drained from paying network fees, (3) skims the remaining
// surplus to the cold TREASURY as profit. all reserves respected. requires the
// admin key (it is the account holding the fees).
async function metabolize(): Promise<void> {
  if (!adminKeypair) {
    lastMetabolism = { ...lastMetabolism, at: new Date().toISOString(), note: 'no ADMIN_SECRET — metabolism needs the fee-holding key' };
    return;
  }
  try {
    const healer = adminKeypair;                  // = fee_recipient = rent payer = hub
    const relayerPub = relayerKeypair.publicKey(); // pays network gas
    let healerXlm = await xlmBalance(healer.publicKey());
    let relayerXlm = await xlmBalance(relayerPub);
    let refueled = 0, skimmed = 0, note: string | undefined;

    // how much the healer can move without dipping into its own rent buffer.
    const healerSpendable = () => healerXlm - HEALER_MIN_XLM - RESERVE_XLM;

    // (1) REFUEL THE RELAYER GAS ACCOUNT — it drains paying network fees.
    if (relayerXlm < RELAYER_BUFFER_XLM) {
      const need = RELAYER_BUFFER_XLM - relayerXlm;
      const give = Math.min(need, Math.max(0, healerSpendable()));
      if (give >= MIN_SWEEP_XLM) {
        await sendXlm(healer, relayerPub, give, 'refuel-relayer-gas');
        refueled = give; healerXlm -= give; relayerXlm += give;
      } else if (need > 0) {
        note = `relayer gas low (${relayerXlm.toFixed(1)} XLM); healer surplus insufficient to refuel`;
      }
    }

    // (2) SKIM PROFIT TO TREASURY — healer XLM above its rent buffer is profit.
    // Gated to once per SKIM_INTERVAL (weekly) so the treasury only shows occasional
    // lumps — never a per-tx trail. Rent/refuel above already ran this tick regardless.
    if (TREASURY_ADDRESS) {
      const surplus = healerSpendable();
      const skimDue = Date.now() - lastSkimAt >= SKIM_INTERVAL_MS;
      if (surplus >= MIN_SWEEP_XLM && skimDue) {
        await sendXlm(healer, TREASURY_ADDRESS, surplus, 'skim-to-treasury');
        skimmed = surplus; healerXlm -= surplus; lastSkimAt = Date.now();
        try { writeFileSync(SKIM_STATE_FILE, JSON.stringify({ lastSkimAt })); } catch { /* noop */ }
      } else if (surplus >= MIN_SWEEP_XLM) {
        const hrsLeft = Math.ceil((SKIM_INTERVAL_MS - (Date.now() - lastSkimAt)) / 3_600_000);
        note = (note ? note + '; ' : '') + `holding ${surplus.toFixed(1)} XLM profit; next treasury skim in ~${hrsLeft}h (batched for privacy)`;
      }
    } else {
      note = (note ? note + '; ' : '') + 'no TREASURY_ADDRESS — profit stays in healer (fee_recipient) account';
    }

    lastMetabolism = {
      at: new Date().toISOString(), healerXlm, relayerXlm,
      refueled, skimmed, treasury: TREASURY_ADDRESS || null, note,
    };
    console.log(`[metabolism] done — refueled ${refueled} XLM to relayer gas, skimmed ${skimmed} XLM to treasury.`);
  } catch (e: any) {
    console.error('[metabolism] run failed:', e?.message ?? e);
    lastMetabolism = { ...lastMetabolism, at: new Date().toISOString(), note: 'error: ' + (e?.message ?? String(e)) };
  }
}

// one organism tick: heal (pay rent where needed), then metabolize (move money).
async function organismTick(): Promise<void> {
  await keepAliveAll();
  await metabolize();
}

// run once on startup, then on interval
setTimeout(() => organismTick().catch(console.error), 5000);
setInterval(() => organismTick().catch(console.error), KEEPALIVE_INTERVAL_MS);

// start
app.listen(PORT, () => {
  console.log(`Shield Relayer (permissionless) on :${PORT}`);
  console.log(`  Stellar address: ${relayerKeypair.publicKey()}`);
  console.log(`  RPC:             ${RPC_URL}`);
  console.log(`  Pool contract:   ${POOL_CONTRACT}`);
  console.log(`  Mode:            dumb tx submitter — no OFAC, no witness, no attestation.`);
});
