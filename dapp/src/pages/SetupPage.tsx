// dapp/src/pages/setuppage.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { card, cardClass, heading, subHeading, btnPrimary } from '../components/Layout';

export function SetupPage() {
  const w = useWallet();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // already set up — redirect to portfolio
  if (w.shieldedAddress) {
    nav('/');
    return null;
  }

  const handleDerive = async () => {
    if (!w.stellarAddress) return;
    setBusy(true);
    setError(null);
    try {
      await w.deriveKeys();
      nav('/');
    } catch (e: any) {
      let msg = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : 'Key derivation failed — please try again.';
      if (/rejected|cancel|denied/i.test(msg) || msg === '[object Object]') {
        msg = 'Signing failed — make sure your wallet is set to Stellar Testnet and try again.';
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={card} className={cardClass}>
        <h1 style={heading}>Activate Shield</h1>
        <p style={subHeading}>
          Your shielded keys are derived from your Stellar wallet — no extra seed phrase needed.
          Your wallet will ask you to sign a one-time derivation transaction.
        </p>

        <div style={{
          padding: 16, borderRadius: 10, background: 'var(--surface2)',
          border: '1px solid var(--border)', marginBottom: 20, fontSize: 13,
        }}>
          <div style={{ fontWeight: 400, marginBottom: 8, color: 'var(--text)' }}>How it works</div>
          <div style={{ color: 'var(--muted)', lineHeight: 1.7 }}>
            <div style={{ marginBottom: 4 }}>1. Your wallet signs a fixed one-time transaction (memo {'"'}shield:v1:keygen{'"'})</div>
            <div style={{ marginBottom: 4 }}>2. We hash the signature to derive your spending key</div>
            <div style={{ marginBottom: 4 }}>3. The spending key never leaves your browser session</div>
            <div>4. Recovery = reconnect the same Stellar account (any wallet)</div>
          </div>
        </div>

        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)', marginBottom: 20, fontSize: 13, color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--accent)' }}>Security note:</strong> The signature is hashed immediately and never stored. Your wallet's recovery phrase is the only backup needed.
        </div>

        {error && (
          <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {!w.stellarAddress ? (
          <div style={{ color: 'var(--warn)', fontSize: 13 }}>
            Connect a Stellar wallet first to continue.
          </div>
        ) : (
          <button
            style={{ ...btnPrimary, width: '100%', padding: '13px 20px', fontSize: 15 }}
            onClick={handleDerive}
            disabled={busy}
          >
            {busy ? 'Waiting for your wallet…' : 'Derive Shielded Keys'}
          </button>
        )}

        {w.shieldedAddress && (
          <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--success)', fontSize: 13 }}>
            <div style={{ fontWeight: 400, color: 'var(--success)', marginBottom: 4 }}>Keys derived successfully</div>
            <div style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, wordBreak: 'break-all', color: 'var(--muted)' }}>
              {w.shieldedAddress}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
