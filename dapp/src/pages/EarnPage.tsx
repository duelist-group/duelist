// dapp/src/pages/earnpage.tsx
import { useState } from 'react';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label } from '../components/Layout';
import { toast } from 'sonner';

const stats = [
  { value: '5–12%', label: 'APY', icon: '📈' },
  { value: '0%', label: 'Lock-up', icon: '🔓' },
  { value: '100%', label: 'Private', icon: '🛡️' },
];

const roadmap = [
  { quarter: 'Q3 2026', title: 'Blend Protocol Integration', desc: 'Lend shielded assets into Blend pools. Earn yield privately.', active: false },
  { quarter: 'Q4 2026', title: 'Aquarius LP Rewards', desc: 'Provide liquidity with shielded positions. Collect AQUA rewards.', active: false },
  { quarter: 'Q1 2027', title: 'Auto-compound Vaults', desc: 'Set-and-forget vaults that reinvest your yield automatically.', active: false },
];

export function EarnPage() {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  const handleSubscribe = () => {
    if (!email.trim()) {
      toast.error('Please enter your email address.');
      return;
    }
    if (!email.includes('@') || !email.includes('.')) {
      toast.error('Please enter a valid email address (e.g. name@example.com).');
      return;
    }
    const existing = JSON.parse(localStorage.getItem('earn-waitlist') || '[]');
    if (!existing.includes(email)) {
      existing.push(email);
      localStorage.setItem('earn-waitlist', JSON.stringify(existing));
    }
    setSubscribed(true);
    toast.success("You're on the waitlist!");
  };

  return (
    <div>
      <div style={card} className={cardClass}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h1 style={{ ...heading, marginBottom: 0 }}>Earn</h1>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
            background: 'linear-gradient(135deg, #a78bfa, #818cf8)', color: '#fff',
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>Coming Soon</span>
        </div>
        <p style={subHeading}>
          Earn yield on your shielded assets. All positions are private — nobody can see what you've deposited or how much you've earned.
        </p>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
          {stats.map(s => (
            <div key={s.label} style={{
              textAlign: 'center', padding: '20px 12px', background: 'var(--panel2)',
              borderRadius: 12, border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{s.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Roadmap */}
        <h3 style={{ fontSize: 14, fontWeight: 400, marginBottom: 12, marginTop: 0, color: 'var(--text)' }}>Roadmap</h3>
        <div style={{ position: 'relative', paddingLeft: 24 }}>
          <div style={{
            position: 'absolute', left: 7, top: 4, bottom: 4, width: 2,
            background: 'var(--border)',
          }} />
          {roadmap.map((item, i) => (
            <div key={i} style={{ position: 'relative', marginBottom: 20, paddingLeft: 16 }}>
              <div style={{
                position: 'absolute', left: -20, top: 4, width: 12, height: 12, borderRadius: '50%',
                background: item.active ? 'var(--accent)' : 'var(--border)',
                border: '2px solid var(--panel)',
              }} />
              <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)', marginBottom: 2 }}>{item.quarter}</div>
              <div style={{ fontSize: 14, fontWeight: 400, color: 'var(--text)', marginBottom: 2 }}>{item.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{item.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Waitlist */}
      <div style={card} className={cardClass}>
        <h2 style={{ ...heading, fontSize: 16 }}>Get notified</h2>
        <p style={subHeading}>Be the first to know when Earn launches.</p>
        {subscribed ? (
          <div style={{
            padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 8, fontSize: 13, color: 'var(--success)',
          }}>
            ✓ You're on the list! We'll notify you at <strong>{email}</strong>.
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com" style={{ flex: 1 }} />
            <button style={btnPrimary} onClick={handleSubscribe} disabled={!email.includes('@')}>
              Notify me
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
