// dapp/src/pages/blockedpage.tsx
// displayed when a users address is flagged by ofac sanctions screening.
import { card, heading, btnSecondary } from '../components/Layout';

export function BlockedPage() {
  return (
    <div style={{ maxWidth: 520, margin: '60px auto', padding: '0 16px' }}>
      <div style={{
        ...card,
        textAlign: 'center',
        padding: '48px 32px',
        border: '1px solid rgba(255,59,48,0.3)',
        background: 'linear-gradient(180deg, rgba(255,59,48,0.04) 0%, var(--panel) 100%)',
      }}>
        {/* Warning icon */}
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: 'rgba(255,59,48,0.1)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 36,
          margin: '0 auto 24px',
          border: '2px solid rgba(255,59,48,0.2)',
        }}>
          🚫
        </div>

        <h1 style={{ ...heading, fontSize: 22, color: '#ff3b30', marginBottom: 12 }}>
          Access Restricted
        </h1>

        <p style={{
          fontSize: 14, color: 'var(--muted)', lineHeight: 1.7,
          maxWidth: 400, margin: '0 auto 24px',
        }}>
          Your wallet address has been identified on a <strong style={{ color: 'var(--text)' }}>sanctions list</strong> maintained 
          by the U.S. Office of Foreign Assets Control (OFAC).
        </p>

        <div style={{
          padding: '16px 20px', borderRadius: 10,
          background: 'rgba(255,59,48,0.06)',
          border: '1px solid rgba(255,59,48,0.15)',
          textAlign: 'left', fontSize: 13, lineHeight: 1.8,
          color: 'var(--muted)', marginBottom: 24,
        }}>
          <strong style={{ color: 'var(--text)', fontSize: 13 }}>What this means:</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Deposits, transfers, and withdrawals are <strong style={{ color: '#ff3b30' }}>blocked</strong> for this address.</li>
            <li>The Duelist relayer enforces OFAC screening on all mainnet transactions.</li>
            <li>This restriction is mandated by U.S. law and cannot be overridden by the protocol admin.</li>
          </ul>
        </div>

        <div style={{
          padding: '14px 20px', borderRadius: 10,
          background: 'var(--panel2)',
          border: '1px solid var(--border)',
          textAlign: 'left', fontSize: 13, lineHeight: 1.8,
          color: 'var(--muted)', marginBottom: 32,
        }}>
          <strong style={{ color: 'var(--text)', fontSize: 13 }}>If you believe this is an error:</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            <li>Verify your address on the <a href="https://sanctionssearch.ofac.treas.gov/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>OFAC SDN List</a></li>
            <li>Contact your legal counsel for guidance on sanctions compliance</li>
            <li>If your address was flagged in error, contact the relayer operator</li>
          </ul>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            style={{ ...btnSecondary, padding: '10px 24px' }}
            onClick={() => window.location.href = '/'}
          >
            Return to Home
          </button>
          <a
            href="https://sanctionssearch.ofac.treas.gov/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...btnSecondary,
              padding: '10px 24px',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            Check OFAC List ↗
          </a>
        </div>
      </div>

      {/* Legal disclaimer */}
      <p style={{
        textAlign: 'center', fontSize: 11, color: 'var(--muted)',
        marginTop: 20, lineHeight: 1.6, opacity: 0.7,
      }}>
        Duelist complies with applicable sanctions regulations.
        Screening is performed via the Chainalysis API. No personal data is stored.
      </p>
    </div>
  );
}
