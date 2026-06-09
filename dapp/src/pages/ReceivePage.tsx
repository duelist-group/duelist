// dapp/src/pages/receivepage.tsx
import { QRCodeSVG } from 'qrcode.react';
import { useWallet } from '../hooks/WalletContext';
import { card, cardClass, heading, subHeading, btnPrimary } from '../components/Layout';
import { useViewport } from '../hooks/useViewport';
import { toast } from 'sonner';

import warriorLeft from '../assets/warriorleftreceive.svg';
import warriorRight from '../assets/warriorrightreceive.svg';
import clipboardIcon from '../assets/icons/clipboard.svg';

export function ReceivePage() {
  const w = useWallet();
  const vp = useViewport();

  if (!w.shieldedAddress) {
    return (
      <div style={card} className={cardClass}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Shielded keys not yet derived. Complete setup first.
        </p>
      </div>
    );
  }

  const addr = w.shieldedAddress;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(addr);
    toast.success('Address copied to clipboard');
  };

  return (
    <div>
      <div className={cardClass} style={{ ...card, marginBottom: 20 }}>
        <h1 style={heading}>Receive</h1>
        <p style={{ ...subHeading, fontSize: vp.isMobile ? 12 : subHeading.fontSize }}>
          Share this shielded address. Senders encrypt notes to your viewing key — only your spending key can unlock them.
        </p>

        {/* Warriors + QR layout — warriors are decorative, dropped on compact screens
            so the QR has room and nothing overflows horizontally. */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
          marginBottom: 22,
          padding: '4px 0',
        }}>
          {!vp.isCompact && (
            <img
              src={warriorLeft}
              alt=""
              aria-hidden
              style={{ height: 350, width: 'auto', flexShrink: 0, opacity: 0.88, userSelect: 'none' }}
            />
          )}

          <div style={{
            background: '#ffffff',
            padding: vp.isMobile ? 14 : 20,
            borderRadius: 14,
            border: '1px solid var(--border)',
            boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
            display: 'inline-flex',
            flexShrink: 0,
            zIndex: 1,
            maxWidth: '100%',
          }}>
            <QRCodeSVG
              value={addr}
              size={vp.isMobile ? 200 : 260}
              bgColor="#ffffff"
              fgColor="#1a1a1a"
              level="M"
              style={{ width: '100%', height: 'auto', maxWidth: vp.isMobile ? 200 : 260 }}
            />
          </div>

          {!vp.isCompact && (
            <img
              src={warriorRight}
              alt=""
              aria-hidden
              style={{ height: 350, width: 'auto', flexShrink: 0, opacity: 0.88, userSelect: 'none' }}
            />
          )}
        </div>

        {/* Address text */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '13px 18px',
          fontFamily: "'Geist Mono', monospace",
          fontSize: 12.5,
          wordBreak: 'break-all',
          color: 'var(--text)',
          lineHeight: 1.7,
          textAlign: 'center',
          marginBottom: 14,
          letterSpacing: '0',
        }}>
          {addr}
        </div>

        {/* Copy button */}
        <button
          style={{
            ...btnPrimary,
            width: '100%',
            padding: '13px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 14.5,
          }}
          onClick={handleCopy}
        >
          <img src={clipboardIcon} width={15} height={15} style={{ filter: 'brightness(0) invert(1)', flexShrink: 0 }} />
          Copy Address
        </button>
      </div>

      {/* Plain info text below — matches card width exactly */}
      {(['Your shielded address lives entirely inside the privacy pool. It has no connection to your public Stellar wallet, no history, and no name attached to it. It was derived from a secret only you hold, so even if someone had your address, they could see nothing of what you own or where it came from.',
        'Fun fact: the smart contract has no idea how much money is inside any individual note. It only ever sees a fingerprint. The actual amounts are known only to you and whoever you chose to tell.'] as string[]).map((text, i, arr) => (
        <p key={i} style={{
          fontFamily: "'Crimson Pro', serif",
          fontSize: 17.5,
          color: 'var(--prose)',
          lineHeight: 1.75,
          margin: 0,
          marginBottom: i < arr.length - 1 ? 20 : 0,
          padding: 0,
          width: '100%',
          boxSizing: 'border-box',
          display: 'block',
          letterSpacing: '-0.016em',
          fontWeight: 400,
        }}>
          {text}
        </p>
      ))}
    </div>
  );
}
