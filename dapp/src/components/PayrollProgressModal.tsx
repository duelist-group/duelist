// dapp/src/components/payrollprogressmodal.tsx
// Payroll is now a SINGLE batch transaction (one ZK proof, one tx, all recipients).
// So this modal is a clean single-tx success — not a per-recipient multi-tx progress.
import { useNavigate } from 'react-router-dom';
import checkIcon from '../assets/icons/check.svg';
import xIcon from '../assets/icons/x.svg';

export interface PayrollStatus {
  id: string;
  shortAddr: string;
  state: 'pending' | 'proving' | 'submitting' | 'success' | 'failed';
  error?: string;
}

interface Props {
  statuses: PayrollStatus[];
  total: number;
  onDismiss: () => void;
}

const GREEN_FILTER = 'invert(48%) sepia(79%) saturate(476%) hue-rotate(86deg) brightness(0.9)';
const RED_FILTER = 'invert(27%) sepia(96%) saturate(4500%) hue-rotate(340deg) brightness(0.9)';

export function PayrollProgressModal({ statuses, total, onDismiss }: Props) {
  const navigate = useNavigate();

  // All recipients are paid in ONE batch tx — derive a single overall phase.
  const phase: 'proving' | 'submitting' | 'success' | 'failed' | 'pending' =
    statuses.some(s => s.state === 'failed') ? 'failed'
    : statuses.length > 0 && statuses.every(s => s.state === 'success') ? 'success'
    : statuses.some(s => s.state === 'submitting') ? 'submitting'
    : statuses.some(s => s.state === 'proving') ? 'proving'
    : 'pending';
  const isComplete = phase === 'success' || phase === 'failed';
  const errorMsg = statuses.find(s => s.state === 'failed')?.error;

  const title = phase === 'success' ? 'Payroll Complete'
    : phase === 'failed' ? 'Payroll Failed'
    : 'Sending Payroll';
  const subtitle = phase === 'success'
      ? `${total} recipient${total !== 1 ? 's' : ''} paid in a single transaction`
    : phase === 'failed'
      ? (errorMsg ? (errorMsg.length > 120 ? errorMsg.slice(0, 120) + '…' : errorMsg) : 'The transaction did not go through — your funds are safe. Just retry.')
    : phase === 'submitting'
      ? 'Submitting the batch transaction…'
    : phase === 'proving'
      ? `Generating one ZK proof for all ${total} recipient${total !== 1 ? 's' : ''}…`
      : 'Preparing…';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--modal-overlay, rgba(248,248,248,0.82))',
      backdropFilter: 'blur(14px) saturate(130%)',
      WebkitBackdropFilter: 'blur(14px) saturate(130%)',
      maskImage: 'radial-gradient(ellipse 80% 85% at center, black 40%, transparent 100%)',
      WebkitMaskImage: 'radial-gradient(ellipse 80% 85% at center, black 40%, transparent 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      animation: 'pageFadeIn 0.18s ease forwards',
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding: '32px 28px 24px',
        width: '100%',
        maxWidth: 460,
        maxHeight: '82vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 32px 80px rgba(0,0,0,0.12)',
        animation: 'pageFadeIn 0.2s ease forwards',
      }}>
        {/* Hero icon (same check as elsewhere) */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          {phase === 'success' ? (
            <div style={{ width: 66, height: 66, borderRadius: '50%', background: 'var(--accent-12)', border: '1.5px solid var(--green)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src={checkIcon} width={30} height={30} style={{ filter: GREEN_FILTER }} />
            </div>
          ) : phase === 'failed' ? (
            <div style={{ width: 66, height: 66, borderRadius: '50%', background: 'rgba(239,68,68,0.1)', border: '1.5px solid var(--red)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src={xIcon} width={26} height={26} style={{ filter: RED_FILTER }} />
            </div>
          ) : (
            <div style={{ width: 66, height: 66, borderRadius: '50%', border: '3px solid var(--green)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
          )}
        </div>

        {/* Title + subtitle */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontFamily: "'Crimson Pro', serif", fontSize: 28, fontWeight: 400, color: phase === 'failed' ? 'var(--red)' : 'var(--text)', marginBottom: 6, lineHeight: 1.1 }}>
            {title}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>{subtitle}</div>
        </div>

        {/* Keep-screen-open warning while the proof runs on this device */}
        {!isComplete && (
          <div style={{
            marginBottom: 4, padding: '10px 14px', borderRadius: 10,
            background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)',
            fontSize: 12.5, color: 'var(--orange)', lineHeight: 1.5,
          }}>
            ⚠️ Keep this screen open — the proof is generated on your device. Don't switch apps or lock the screen until it finishes. Your funds are safe if interrupted; just retry.
          </div>
        )}

        {/* Recipient confirmation list — only once complete (it's one tx, not N) */}
        {isComplete && (
          <div style={{ overflowY: 'auto', maxHeight: '38vh', marginRight: -4, paddingRight: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            {statuses.map((s, i) => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0',
                borderBottom: i < statuses.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: phase === 'failed' ? 'rgba(239,68,68,0.1)' : 'var(--accent-12)',
                  border: `1.5px solid ${phase === 'failed' ? 'var(--red)' : 'var(--green)'}`,
                }}>
                  <img src={phase === 'failed' ? xIcon : checkIcon} width={12} height={12} style={{ filter: phase === 'failed' ? RED_FILTER : GREEN_FILTER }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, fontFamily: "'Geist Mono', monospace", fontSize: 12, color: 'var(--text)' }}>{s.shortAddr}</div>
                <div style={{ fontSize: 11, color: 'var(--muted2)', flexShrink: 0 }}>#{i + 1}</div>
              </div>
            ))}
          </div>
        )}

        {/* Action buttons when complete */}
        {isComplete && (
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button
              onClick={onDismiss}
              style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 400, color: 'var(--text)', cursor: 'pointer', fontFamily: "'Geist', sans-serif" }}
            >
              Close
            </button>
            <button
              onClick={() => { onDismiss(); navigate('/history'); }}
              style={{ flex: 1, background: 'var(--green)', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 400, color: '#fff', cursor: 'pointer', fontFamily: "'Geist', sans-serif" }}
            >
              View History →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
