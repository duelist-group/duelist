// dapp/src/components/DebugPanel.tsx
// Temporary on-screen diagnostic, shown only when ?debug=1 (sticky). Survives
// reloads so we can see what happened right before a mobile reload. REMOVE later.
import { useEffect, useState } from 'react';
import { dlogGet, dlogClear } from '../lib/debugLog';

export function DebugPanel() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 800);
    return () => clearInterval(id);
  }, []);
  const log = dlogGet().slice().reverse();
  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 99999,
      maxHeight: '42vh', overflowY: 'auto',
      background: 'rgba(0,0,0,0.92)', color: '#0f0',
      fontFamily: 'monospace', fontSize: 11, lineHeight: 1.45,
      padding: '8px 10px', borderTop: '2px solid #0f0',
    }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, color: '#fff' }}>
        <strong>debug log ({log.length})</strong>
        <button onClick={() => { dlogClear(); tick(n => n + 1); }} style={{ fontSize: 11 }}>clear</button>
        <button onClick={() => { try { navigator.clipboard.writeText(JSON.stringify(dlogGet())); } catch {} }} style={{ fontSize: 11 }}>copy</button>
        <span style={{ color: '#888' }}>?debug=1 · remove later</span>
      </div>
      {log.map((e, i) => (
        <div key={i}><span style={{ color: '#888' }}>{e.t}</span> {e.tag}</div>
      ))}
    </div>
  );
}
