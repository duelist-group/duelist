// dapp/src/components/connectwalletmodal.tsx
import { useEffect, useState } from 'react';
import { useWallet } from '../hooks/WalletContext';
import { useDarkMode } from '../hooks/useDarkMode';
import logoSrc from '../assets/logo2.svg';
import { listWallets, WALLET_CONNECT_WALLET_ID, ALBEDO_WALLET_ID, type WalletOption } from '../lib/walletKit';

function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: 16, height: 16,
      border: '2px solid var(--border)',
      borderTopColor: 'var(--text)',
      borderRadius: '50%',
      animation: 'spin 0.65s linear infinite',
      flexShrink: 0,
    }} />
  );
}

const isMobile =
  typeof navigator !== 'undefined' &&
  (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches));

function subtitleFor(id: string): string {
  if (id === WALLET_CONNECT_WALLET_ID) return isMobile ? 'Open your wallet app' : 'Scan with your phone wallet';
  return 'Browser extension';
}

export function ConnectWalletModal() {
  const w = useWallet();
  const { dark } = useDarkMode();
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // load the wallet list once; render our own picker from it.
  useEffect(() => {
    let alive = true;
    listWallets()
      .then(list => { if (alive) setWallets(list); })
      .catch(() => { if (alive) setWallets([]); });
    return () => { alive = false; };
  }, []);

  // lock background scroll while the connect modal is open (mobile: stops the page
  // behind the modal from scrolling, which felt broken). restore on unmount.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  const handleConnect = async (walletId: string) => {
    setConnectingId(walletId);
    setError(null);
    try {
      await w.connectWallet(walletId);
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      if (!/clos|cancel|dismiss|reject(ed)? by (the )?user/i.test(msg)) setError(msg);
    } finally {
      setConnectingId(null);
    }
  };

  // Show: every detected wallet + WalletConnect (always — universal). Hide
  // undetected extensions (the confusing "Install" rows, esp. on mobile) and
  // Albedo (its popup flow conflicts with the COEP headers proving needs).
  const shown = (wallets ?? [])
    .filter(x =>
      x.id !== ALBEDO_WALLET_ID &&
      // detected extensions always; WalletConnect ONLY on mobile. On desktop the
      // WC modal pushes EVM wallets (TrustWallet etc.), not Stellar wallets, so we
      // hide it there — desktop users connect a Stellar extension (Freighter…).
      (x.isAvailable || (x.id === WALLET_CONNECT_WALLET_ID && isMobile)))
    .sort((a, b) => {
      // WalletConnect first on mobile; detected extensions otherwise.
      const rank = (x: WalletOption) => (x.id === WALLET_CONNECT_WALLET_ID ? 0 : 1);
      return rank(a) - rank(b);
    });

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 900,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // solid theme background — hide the app behind the connect screen entirely
      // (no blurred details showing through), per design.
      background: 'var(--bg)',
    }}>
      <div style={{
        background: 'var(--surface)',
        borderRadius: 16,
        padding: '36px 28px 28px',
        maxWidth: 400,
        width: '90%',
        border: '1px solid var(--border)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.13)',
        animation: 'pageFadeIn 0.18s ease forwards',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <img
            src={logoSrc}
            alt="Duelist"
            style={{
              width: 80, height: 80,
              filter: dark ? 'brightness(0) invert(1)' : 'brightness(0.1)',
              display: 'block', margin: '3px auto 16px',
            }}
          />
          <h2 style={{
            margin: '0 0 8px',
            fontFamily: "'Crimson Pro', serif",
            fontSize: 38,
            fontWeight: 400,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            color: 'var(--text)',
          }}>
            Hey there ;)
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>
            Shielded balances and private payments on Stellar.
          </p>
        </div>

        {/* Value props — fills the screen on mobile + sets expectations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 22 }}>
          {[
            'Private balances, transfers and withdrawals',
            'Batch payroll in one transaction',
            'Non-custodial, no seed phrase',
          ].map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, fontSize: 13, color: 'var(--muted)', lineHeight: 1.4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted2)', fontVariantNumeric: 'tabular-nums', flexShrink: 0, width: 12, textAlign: 'center' }}>{i + 1}</span>
              {t}
            </div>
          ))}
        </div>

        {/* Wallet rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {wallets === null && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}><Spinner /></div>
          )}

          {wallets !== null && shown.map(wallet => {
            const busy = connectingId === wallet.id;
            const disabled = connectingId !== null && !busy;
            const isWC = wallet.id === WALLET_CONNECT_WALLET_ID;
            return (
              <button
                key={wallet.id}
                onClick={() => handleConnect(wallet.id)}
                disabled={disabled}
                style={{
                  display: 'flex', alignItems: 'center', gap: 13,
                  padding: '13px 15px',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: isWC ? 'var(--green-bg)' : 'var(--bg)',
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: disabled ? 0.45 : 1,
                  textAlign: 'left',
                  width: '100%',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                {wallet.icon
                  ? <img src={wallet.icon} width={30} height={30} alt="" style={{ borderRadius: 8, flexShrink: 0 }} onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                  : <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface2)', flexShrink: 0 }} />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 500, fontSize: 14, color: 'var(--text)' }}>{wallet.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{subtitleFor(wallet.id)}</span>
                </span>
                {busy && <Spinner />}
              </button>
            );
          })}

          {wallets !== null && shown.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', padding: '12px 0' }}>
              No Stellar wallet detected. Install Freighter, Rabet, or xBull.
            </div>
          )}
        </div>

        {error && (
          <div style={{
            marginTop: 14,
            padding: '10px 14px',
            borderRadius: 10,
            background: 'var(--red-bg)',
            border: '1px solid rgba(239,68,68,0.3)',
            fontSize: 13,
            color: 'var(--red)',
          }}>
            {error}
          </div>
        )}

        <p style={{
          marginTop: 18, marginBottom: 0,
          textAlign: 'center', fontSize: 12,
          color: 'var(--muted)', lineHeight: 1.6,
        }}>
          {isMobile
            ? 'WalletConnect opens your wallet app, then returns here.'
            : 'On a phone? Open app.duelist.finance in your mobile browser.'}
        </p>
      </div>
    </div>
  );
}
