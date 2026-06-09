// dapp/src/hooks/walletcontext.tsx
// no wasm on the main thread. all crypto lives in shieldworker.ts.
// wallet connection + signing go through the Stellar Wallets Kit (see lib/walletKit.ts):
// Freighter/Albedo/xBull/Lobstr on desktop, WalletConnect (app deep-link) on mobile.
// spending key is derived from a deterministic wallet tx-signature — same account =
// same shielded wallet on every wallet/device; no separate mnemonic needed.

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { sha256 } from '@noble/hashes/sha2.js';
import { Account, TransactionBuilder, BASE_FEE, Operation, Memo } from '@stellar/stellar-sdk';
import { NETWORK } from '../lib/config';
import { connectViaModal, connectWithWallet, restoreWallet, kitSignTx, disconnectKit, ensureKitInit } from '../lib/walletKit';
import { dlog } from '../lib/debugLog';

// constants

const GRUMPKIN_ORDER = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const SESSION_KEY = 'duelist-session';

// session helpers (sessionstorage — cleared on tab close)

interface Session {
  stellarAddress: string;
  walletType: WalletType;
  spendingKeyHex: string;
  shieldedAddress: string;
  shieldedPkX: string;
  shieldedPkY: string;
  balancesJson?: string;
}

function saveSession(s: Session) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* noop */ }
}
function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
}

// types

// the Stellar Wallets Kit product id of the connected wallet
// ('freighter' | 'albedo' | 'xbull' | 'lobstr' | 'walletconnect' | …)
export type WalletType = string;

export interface ProveDepositResult {
  commitment: string;
  netAmount: string;
  proofBytes: number[];
  publicInputs: string[];
  encryptedCiphertext: number[];
  encryptedEphemeralPk: number[];
}

export interface ProveTransferResult {
  proofBytes: number[];
  publicInputs: string[];
  publicData: {
    poolRoot: string;
    nullifier1: string;
    nullifier2: string;
    outputCommitment1: string;
    outputCommitment2: string;
    assetId: string;
    fee: string;
    txHash: string;
  };
  encryptedNotes: Array<{ ciphertext: number[]; ephemeralPk: number[] }>;
}

export interface ProveWithdrawResult {
  proofBytes: number[];
  publicInputs: string[];
  publicData: {
    poolRoot: string;
    nullifiers: string[];
    changeCommitment: string;
    decoyCommitment: string;
    assetId: string;
    withdrawAmount: string;
    fee: string;
    recipientStellarHash: string;
    txHash: string;
  };
  encryptedNoteChange: { ciphertext: number[]; ephemeralPk: number[] };
  encryptedNoteDecoy: { ciphertext: number[]; ephemeralPk: number[] };
}

export interface ProveTransferBatchResult {
  proofBytes: number[];
  publicInputs: string[];
  publicData: {
    poolRoot: string;
    nullifiers: string[];
    outCommitments: string[];
    assetId: string;
    fee: string;
    txHash: string;
    recipientCount: number;
  };
  encryptedNotes: Array<{ ciphertext: number[]; ephemeralPk: number[] }>;
}

export interface POIAttestation {
  version: number;
  commitment: string;
  assetId: string;
  amount: string;
  leafIndex: number;
  poolRoot: string;
  blacklistRoot: string;
  sourceAddress: string;
  attestationHash: string;
  signature: string;
  signerPkX: string;
  signerPkY: string;
  timestamp: number;
}

interface WalletState {
  stellarAddress: string | null;
  walletType: WalletType | null;
  isInitializing: boolean;
  isRestoringSession: boolean;
  isRefreshing: boolean;
  error: string | null;

  shieldedAddress: string | null;
  shieldedPkX: string | null;
  shieldedPkY: string | null;
  balances: Map<string, bigint>;
  ownedCommitments: Map<string, { amount: string; assetId: string; spent?: boolean }>;
  nullifierAmounts: Map<string, { amount: bigint; assetId: string }>;

  connectWallet: (walletId?: string) => Promise<void>;
  deriveKeys: () => Promise<void>;
  proveDeposit: (assetIdHex: string, grossAmount: string, feeBps: number) => Promise<ProveDepositResult>;
  proveTransfer: (recipientAddress: string, assetIdHex: string, amount: string, fee: string) => Promise<ProveTransferResult>;
  proveTransferBatch: (recipients: { address: string; amount: string }[], assetIdHex: string, fee: string) => Promise<ProveTransferBatchResult>;
  proveWithdraw: (assetIdHex: string, recipientStellarAddress: string, fee: string, withdrawAmount: string) => Promise<ProveWithdrawResult>;
  refresh: () => Promise<void>;
  getPoolRoot: () => Promise<string>;
  getViewingKey: () => Promise<string>;
  generatePOI: (commitmentHex: string, sourceAddress: string) => Promise<POIAttestation>;
  verifyPOI: (attestationJson: string) => Promise<{ valid: boolean; signerPkX?: string; signerPkY?: string }>;
  signXdr: (xdr: string) => Promise<string>;
  resetWallet: () => void;
}

// context

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}

// key derivation helpers

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

/**
 * Derive the shielded spending key by signing a fixed no-op transaction with the
 * connected wallet, then hashing the ed25519 signature into the Grumpkin field.
 *
 * Why a transaction (not signMessage): ed25519 is deterministic, so the SAME
 * Stellar account signs this exact tx to the SAME 64 bytes on every wallet and
 * device — Freighter on desktop, WalletConnect/Albedo on a phone — which means
 * the user unlocks the identical shielded wallet everywhere. signMessage formats
 * differ across wallets and would fork the key per wallet, so we don't use it.
 */
async function deriveSpendingKey(stellarAddress: string): Promise<string> {
  const dummyAccount = new Account(stellarAddress, '0');
  const keygenTx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.networkPassphrase,
  })
    .addMemo(Memo.text('shield:v1:keygen'))
    .addOperation(Operation.setOptions({}))
    .setTimeout(0)
    .build();

  const signedXdr = await kitSignTx(keygenTx.toXDR(), stellarAddress);

  // extract the 64-byte ed25519 signature from the signed xdr
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK.networkPassphrase);
  const sigArr = (signedTx as any).signatures[0].signature();
  const sigBytes: Uint8Array = sigArr instanceof Uint8Array ? sigArr : new Uint8Array(sigArr);

  const hashBytes = sha256(sigBytes);
  let sk = bytesToBigInt(hashBytes) % GRUMPKIN_ORDER;
  if (sk === 0n) sk = 1n;
  return '0x' + sk.toString(16).padStart(64, '0');
}

// provider

export function WalletProvider({ children }: { children: ReactNode }) {
  const [stellarAddress, setStellarAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [hadSessionOnMount] = useState(() => loadSession() !== null);
  const [error, setError] = useState<string | null>(null);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [shieldedAddress, setShieldedAddress] = useState<string | null>(null);
  const [shieldedPkX, setShieldedPkX] = useState<string | null>(null);
  const [shieldedPkY, setShieldedPkY] = useState<string | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [ownedCommitments, setOwnedCommitments] = useState<Map<string, { amount: string; assetId: string; spent?: boolean }>>(new Map());
  const [nullifierAmounts, setNullifierAmounts] = useState<Map<string, { amount: bigint; assetId: string }>>(new Map());

  // worker management
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>>(new Map());
  const nextIdRef = useRef(0);
  // true while a proof is generating — the silent background poll pauses so it
  // never refreshes balances mid-process.
  const txBusyRef = useRef(false);

  // run a proof job with the busy flag held (pauses the background sync) AND a
  // screen wake-lock so the device doesn't sleep mid-proof (a reload trigger on
  // mobile while you wait for a heavy proof like payroll).
  async function withTxBusy<T>(fn: () => Promise<T>): Promise<T> {
    txBusyRef.current = true;
    let lock: any = null;
    try { lock = await (navigator as any).wakeLock?.request?.('screen'); } catch { /* unsupported / denied */ }
    try {
      return await fn();
    } finally {
      txBusyRef.current = false;
      try { await lock?.release?.(); } catch { /* noop */ }
    }
  }

  function send<T>(msg: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextIdRef.current++;
      pendingRef.current.set(id, { resolve, reject });
      workerRef.current?.postMessage({ id, ...msg });
    });
  }

  // restore cached balances instantly from sessionstorage before the worker is ready
  useEffect(() => {
    const session = loadSession();
    if (session?.balancesJson) {
      try {
        const cached = JSON.parse(session.balancesJson) as Record<string, string>;
        setBalances(new Map(Object.entries(cached).map(([k, v]) => [k, BigInt(v)])));
        setIsRefreshing(true); // signal that this is stale, scan will update it
      } catch { /* ignore corrupt cache */ }
    }
  }, []);

  // boot worker + auto-reconnect freighter + restore session (all in one flow)
  useEffect(() => {
    const w = new Worker(
      new URL('../workers/shieldWorker.ts', import.meta.url),
      { type: 'module' },
    );
    w.onmessage = (e) => {
      const { id, ok, result, error: err } = e.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (ok) pending.resolve(result);
      else pending.reject(new Error(err));
    };
    w.onerror = (e) => { console.error('Shield worker error:', e); };
    workerRef.current = w;

    // Pre-warm the Barretenberg WASM off the main thread the instant the worker boots,
    // so it's already compiled by the time the user reaches Derive — the first poseidon2
    // (inside `unlock`) then runs instantly instead of paying the ~10 MB compile on click.
    send({ type: 'prewarm' }).catch(() => {});

    (async () => {
      try {
        await ensureKitInit();

        // restore the in-tab session (sessionStorage) if one exists — re-select the
        // wallet so future signing works, and unlock the shielded wallet from the
        // cached spending key (no re-signing needed).
        const session = loadSession();
        if (session?.stellarAddress) {
          await restoreWallet(session.walletType);
          setStellarAddress(session.stellarAddress);
          setWalletType(session.walletType);

          const result = await send<{ shieldedAddress: string; shieldedPkX: string; shieldedPkY: string }>({
            type: 'unlock',
            spendingKeyHex: session.spendingKeyHex,
            indexerUrl: NETWORK.indexerUrls[0] ?? '',
            poolContract: NETWORK.poolContract,
          });
          setShieldedAddress(result.shieldedAddress);
          setShieldedPkX(result.shieldedPkX);
          setShieldedPkY(result.shieldedPkY);
          // restore cached balances immediately so they show before the scan completes
          if (session.balancesJson) {
            try {
              const cached = JSON.parse(session.balancesJson) as Record<string, string>;
              setBalances(new Map(Object.entries(cached).map(([k, v]) => [k, BigInt(v)])));
            } catch { /* stale cache, ignore */ }
          }
        }
      } catch { /* ignore */ }
      setIsInitializing(false);
    })();

    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  // Connect a wallet. With a walletId (from our custom picker) we connect that
  // wallet directly (WalletConnect triggers its own pairing QR/deep-link UI);
  // without one we fall back to the kit's built-in picker.
  const connectWallet = async (walletId?: string): Promise<void> => {
    dlog('connect:start ' + (walletId || 'modal'));
    const result = walletId ? await connectWithWallet(walletId) : await connectViaModal();
    if (!result.address) throw new Error('No address returned from the wallet');
    dlog('connect:done ' + result.walletId);
    setStellarAddress(result.address);
    setWalletType(result.walletId || 'unknown');
  };

  const deriveKeys = async (): Promise<void> => {
    if (!stellarAddress) throw new Error('Connect a Stellar wallet first');
    dlog('derive:start');
    const skHex = await deriveSpendingKey(stellarAddress);
    dlog('derive:signed');
    const result = await send<{ shieldedAddress: string; shieldedPkX: string; shieldedPkY: string }>({
      type: 'unlock',
      spendingKeyHex: skHex,
      indexerUrl: NETWORK.indexerUrls[0] ?? '',
      poolContract: NETWORK.poolContract,
    });
    dlog('derive:unlocked');
    setShieldedAddress(result.shieldedAddress);
    setShieldedPkX(result.shieldedPkX);
    setShieldedPkY(result.shieldedPkY);
    saveSession({
      stellarAddress,
      walletType: walletType ?? '',
      spendingKeyHex: skHex,
      shieldedAddress: result.shieldedAddress,
      shieldedPkX: result.shieldedPkX,
      shieldedPkY: result.shieldedPkY,
    });
    dlog('derive:session-saved');
  };

  const proveDeposit = (assetIdHex: string, grossAmount: string, feeBps: number): Promise<ProveDepositResult> =>
    withTxBusy(() => send<ProveDepositResult>({ type: 'prove_deposit', assetIdHex, grossAmount, feeBps }));

  const proveTransfer = (recipientAddress: string, assetIdHex: string, amount: string, fee: string): Promise<ProveTransferResult> =>
    withTxBusy(() => send<ProveTransferResult>({ type: 'prove_transfer', recipientAddress, assetIdHex, amount, fee }));

  const proveTransferBatch = (recipients: { address: string; amount: string }[], assetIdHex: string, fee: string): Promise<ProveTransferBatchResult> =>
    withTxBusy(() => send<ProveTransferBatchResult>({ type: 'prove_transfer_batch', recipients, assetIdHex, fee }));

  const proveWithdraw = (assetIdHex: string, recipientStellarAddress: string, fee: string, withdrawAmount: string): Promise<ProveWithdrawResult> =>
    withTxBusy(() => send<ProveWithdrawResult>({ type: 'prove_withdraw', assetIdHex, recipientStellarAddress, fee, withdrawAmount }));

  // `silent` (background poll / post-tx) skips the spinner+toast and never blanks
  // the balance, and bails while a proof/tx is in flight or the tab is hidden —
  // so the UI never flickers or refreshes mid-process.
  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (silent && (txBusyRef.current || (typeof document !== 'undefined' && document.hidden))) return;
    if (!silent) setIsRefreshing(true);
    try {
      await send({ type: 'scan' });
      const [raw, commits, nullMap] = await Promise.all([
        send<Record<string, string>>({ type: 'balances' }),
        send<Record<string, { amount: string; assetId: string; spent?: boolean }>>({ type: 'get_commitments' }),
        send<Record<string, { amount: string; assetId: string }>>({ type: 'get_nullifier_map' }),
      ]);
      const newBalances = new Map(Object.entries(raw).map(([k, v]) => [k, BigInt(v)]));
      setBalances(newBalances);
      setOwnedCommitments(new Map(Object.entries(commits)));
      setNullifierAmounts(new Map(Object.entries(nullMap).map(([k, v]) => [k, { amount: BigInt(v.amount), assetId: v.assetId }])));
      // cache balances so they restore instantly on next page load
      try {
        const session = loadSession();
        if (session) {
          const balancesJson = JSON.stringify(Object.fromEntries([...newBalances.entries()].map(([k, v]) => [k, v.toString()])));
          saveSession({ ...session, balancesJson });
        }
      } catch { /* noop */ }
    } catch (e: any) {
      if (!silent) {
        toast.error(e?.message ?? 'Could not sync — indexer unavailable', { duration: 4000 });
        throw e;
      }
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // initial sync once when keys become available (visible).
  useEffect(() => {
    if (!shieldedAddress) return;
    refresh().catch(() => {});
  }, [shieldedAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  // quiet background sync to catch incoming notes — SILENT (no spinner/toast/dim),
  // paused during transactions and while the tab is hidden. Drives receiver
  // auto-sync (someone sends to your zk1 address → it appears without a manual
  // refresh). 12s keeps it responsive; it's invisible so there's no flicker.
  // Also sync immediately when you return to the tab, so incoming notes show at once.
  useEffect(() => {
    if (!shieldedAddress) return;
    const id = setInterval(() => { refresh(true).catch(() => {}); }, 12_000);
    const onVisible = () => { if (!document.hidden) refresh(true).catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [shieldedAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const getPoolRoot = async (): Promise<string> => {
    const res = await send<{ root: string }>({ type: 'get_root' });
    return res.root;
  };

  const getViewingKey = (): Promise<string> =>
    send<{ viewingKey: string }>({ type: 'get_viewing_key' }).then(r => r.viewingKey);

  const generatePOI = (commitmentHex: string, sourceAddress: string): Promise<POIAttestation> =>
    send<POIAttestation>({ type: 'generate_poi', commitmentHex, sourceAddress });

  const verifyPOI = (attestationJson: string): Promise<{ valid: boolean; signerPkX?: string; signerPkY?: string }> =>
    send({ type: 'verify_poi', attestation: attestationJson });

  const signXdr = (xdr: string): Promise<string> => kitSignTx(xdr, stellarAddress);

  const resetWallet = () => {
    clearSession();
    disconnectKit().catch(() => {});
    send({ type: 'lock' }).catch(() => {});
    setShieldedAddress(null);
    setShieldedPkX(null);
    setShieldedPkY(null);
    setBalances(new Map());
    setOwnedCommitments(new Map());
    setNullifierAmounts(new Map());
    setStellarAddress(null);
    setWalletType(null);
  };

  return (
    <Ctx.Provider value={{
      stellarAddress, walletType, isInitializing, isRestoringSession: hadSessionOnMount && isInitializing, isRefreshing, error,
      shieldedAddress, shieldedPkX, shieldedPkY, balances, ownedCommitments, nullifierAmounts,
      connectWallet, deriveKeys, proveDeposit, proveTransfer, proveTransferBatch, proveWithdraw,
      refresh, getPoolRoot, getViewingKey, generatePOI, verifyPOI, signXdr, resetWallet,
    }}>
      {children}
    </Ctx.Provider>
  );
}
