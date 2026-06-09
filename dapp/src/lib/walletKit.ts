// dapp/src/lib/walletKit.ts
//
// Stellar Wallets Kit singleton — the one place wallet connection/signing lives.
// Gives us, behind a single picker modal:
//   • Freighter   — desktop browser extension
//   • Albedo      — web signer, works right in mobile Safari (no app, no projectId)
//   • xBull/Lobstr — extensions + their in-app browsers
//   • WalletConnect — deep-links into the wallet APP on a phone (the "MetaMask in
//                     Safari → approve in the app → bounce back" flow). Only
//                     registered when VITE_WALLETCONNECT_PROJECT_ID is set, so the
//                     other wallets work immediately and WC lights up once a free
//                     Reown projectId is configured.
//
// Spending-key derivation (in WalletContext) signs a fixed no-op transaction via
// this kit. ed25519 is deterministic, so the same Stellar account yields the same
// signature on every wallet/device → identical shielded wallet on phone & desktop.

import { StellarWalletsKit, Networks, type ISupportedWallet } from '@creit.tech/stellar-wallets-kit';
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { NETWORK } from './config';

const WC_PROJECT_ID =
  ((import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? '').trim();

// our network passphrase → the kit's Networks enum (testnet unless explicitly public)
const kitNetwork =
  NETWORK.networkPassphrase === Networks.PUBLIC ? Networks.PUBLIC : Networks.TESTNET;

// (We do NOT filter/feature WC wallets — see the WalletConnectModule note below;
// any appKitOptions breaks the sign flow in this kit version, and the Stellar
// wallets show in the modal anyway.)

let initPromise: Promise<void> | null = null;

async function doInit(): Promise<void> {
  // built-in wallets — no external config required
  const modules: any[] = [
    new FreighterModule(),
    new AlbedoModule(),
    // LOBSTR removed: its extension/app is mainnet-only → broken on this testnet dapp.
    // (Mobile LOBSTR is still reachable via WalletConnect if the user picks it there.)
  ];

  // WalletConnect is heavy (pulls in Reown AppKit) — load it lazily and only when
  // a projectId exists, so the no-projectId path stays light and can't crash on it.
  if (WC_PROJECT_ID) {
    const { WalletConnectModule, WalletConnectTargetChain } = await import(
      '@creit.tech/stellar-wallets-kit/modules/wallet-connect'
    );
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://shield.local';
    // ⚠️ DO NOT add `appKitOptions` here. ANY of them (includeWalletIds,
    // featuredWalletIds, themeMode) breaks the WalletConnect SIGN flow in this kit
    // version — derive hangs at "Waiting for your wallet…". This minimal metadata-
    // only config is the one verified end-to-end (connect + sign + deposit/withdraw).
    // The Stellar wallets (LOBSTR/Freighter) already appear in the modal without filtering.
    modules.push(
      new WalletConnectModule({
        projectId: WC_PROJECT_ID,
        allowedChains: [
          kitNetwork === Networks.PUBLIC
            ? WalletConnectTargetChain.PUBLIC
            : WalletConnectTargetChain.TESTNET,
        ],
        metadata: {
          name: 'Duelist',
          description: 'Private shielded payments on Stellar',
          url: origin,
          icons: [`${origin}/logo2.svg`],
        },
      }),
    );
  }

  StellarWalletsKit.init({
    network: kitNetwork,
    modules,
    authModal: { showInstallLabel: true },
  });
}

/** Initialise the kit exactly once (idempotent). */
export function ensureKitInit(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

/** Whether the WalletConnect (mobile app deep-link) path is configured. */
export function walletConnectEnabled(): boolean {
  return !!WC_PROJECT_ID;
}

export const WALLET_CONNECT_WALLET_ID = 'wallet_connect';
export const ALBEDO_WALLET_ID = 'albedo';
export type WalletOption = ISupportedWallet;

/** List the supported wallets (with availability) so we can render our own picker. */
export async function listWallets(): Promise<ISupportedWallet[]> {
  await ensureKitInit();
  return StellarWalletsKit.refreshSupportedWallets();
}

/**
 * Connect to a specific wallet id (our custom picker calls this). Uses
 * `fetchAddress()` — NOT `getAddress()`: getAddress only returns a cached
 * address (and throws "No wallet has been connected" when there's none),
 * whereas fetchAddress actually drives the selected module — which for
 * WalletConnect opens the pairing UI (QR / app deep-link) and awaits approval.
 */
export async function connectWithWallet(walletId: string): Promise<{ address: string; walletId: string }> {
  await ensureKitInit();
  StellarWalletsKit.setWallet(walletId);
  const { address } = await StellarWalletsKit.fetchAddress();
  return { address, walletId };
}

/** Open the kit's built-in picker (fallback). Returns address + chosen wallet id. */
export async function connectViaModal(): Promise<{ address: string; walletId: string }> {
  await ensureKitInit();
  const { address } = await StellarWalletsKit.authModal();
  let walletId = '';
  try {
    walletId = StellarWalletsKit.selectedModule?.productId ?? '';
  } catch {
    /* no module selected — leave blank */
  }
  return { address, walletId };
}

/** Re-select a previously chosen wallet so signing works after a same-tab reload. */
export async function restoreWallet(walletId: string): Promise<void> {
  await ensureKitInit();
  if (walletId) {
    try {
      StellarWalletsKit.setWallet(walletId);
    } catch {
      /* module unavailable (e.g. extension removed) — connect again on next sign */
    }
  }
}

/** Sign a transaction XDR with the active wallet; returns the signed XDR. */
export async function kitSignTx(xdr: string, address: string | null): Promise<string> {
  await ensureKitInit();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: NETWORK.networkPassphrase,
    address: address ?? undefined,
  });
  return signedTxXdr;
}

/** Tear down the active wallet connection (used on disconnect/reset). */
export async function disconnectKit(): Promise<void> {
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    /* noop */
  }
}
