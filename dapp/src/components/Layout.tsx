// dapp/src/components/layout.tsx
import { type ReactNode, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useWallet } from '../hooks/WalletContext';
import { useDarkMode } from '../hooks/useDarkMode';
import { useViewport } from '../hooks/useViewport';

import logoSrc from '../assets/logo2.svg';
import historyIcon from '../assets/icons/history.svg';
import settingsIcon from '../assets/icons/settings.svg';
import sendIcon from '../assets/icons/send.svg';
import receiveIcon from '../assets/icons/receive.svg';
import withdrawIcon from '../assets/icons/withdraw.svg';
import payrollIcon from '../assets/icons/payroll.svg';
import piggyIcon from '../assets/icons/piggy-bank.svg';
import depositIcon from '../assets/icons/banknote-arrow-up.svg';
import walletIcon from '../assets/icons/wallet-cards.svg';
import logoutIcon from '../assets/icons/log-out.svg';
import bookIcon from '../assets/icons/book-marked.svg';

/* ── Session greeting (one per tab, 100 options) ── */
interface Greeting { text: string; author?: string; }

const GREETINGS: Greeting[] = [
  { text: 'Rise and shield.' },
  { text: 'Up before the chain.' },
  { text: 'The vault never slept.' },
  { text: 'Dawn breaks, keys hold.' },
  { text: 'Good morning, ghost.' },
  { text: 'Fresh block, fresh start.' },
  { text: 'A new ledger opens.' },
  { text: 'Still standing.' },
  { text: 'High noon, deep vaults.' },
  { text: 'Another day, unbroken.' },
  { text: 'The torches are lit.' },
  { text: 'Night owl.' },
  { text: 'Dark hours, darker proofs.' },
  { text: 'The keep stands.' },
  { text: 'Moonlight suits you.' },
  { text: 'The chain never rests.' },
  { text: 'Neither do the bold.' },
  { text: 'Midnight counsel.' },
  { text: 'The lack of money is the root of all evil.', author: 'Mark Twain' },
  { text: 'Money is a good servant but a bad master.', author: 'Francis Bacon' },
  { text: 'An investment in knowledge pays the best interest.', author: 'Benjamin Franklin' },
  { text: 'Compound interest is the eighth wonder of the world.', author: 'Albert Einstein' },
  { text: 'Time is money.', author: 'Benjamin Franklin' },
  { text: 'Wealth consists not in great possessions, but in having few wants.', author: 'Epictetus' },
  { text: 'It is not the man who has too little, but the man who craves more, that is poor.', author: 'Seneca' },
  { text: 'He is richest who is content with the least.', author: 'Socrates' },
  { text: 'Money often costs too much.', author: 'Ralph Waldo Emerson' },
  { text: 'Not he who has much is rich, but he who gives much.', author: 'Erich Fromm' },
  { text: 'Frugality is the mother of all virtues.', author: 'Cicero' },
  { text: 'Wealth is not his that has it, but his that enjoys it.', author: 'Benjamin Franklin' },
  { text: 'Never spend your money before you have it.', author: 'Thomas Jefferson' },
  { text: 'Fortune favours the prepared mind.', author: 'Louis Pasteur' },
  { text: 'He who does not economize will have to agonize.', author: 'Confucius' },
  { text: 'Every battle is won before it is ever fought.', author: 'Sun Tzu' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'He who rules his spirit is mightier than he who takes a city.', author: 'Proverbs 16:32' },
  { text: 'A feast is made for laughter, but money answereth all things.', author: 'Ecclesiastes 10:19' },
  { text: 'The art is not in making money, but in keeping it.', author: 'Proverb' },
  { text: 'Opportunity is missed because it looks like work.', author: 'Thomas Edison' },
  { text: 'Behind every great fortune there is a crime.', author: 'Honoré de Balzac' },
  { text: 'Money is coined liberty.', author: 'Fyodor Dostoevsky' },
  { text: 'Wealth is the ability to fully experience life.', author: 'Henry David Thoreau' },
  { text: 'Welcome back.' },
  { text: 'Quiet power.' },
  { text: 'The vault endures.' },
  { text: 'Steady hands, clear keys.' },
  { text: 'Back in the shadows.' },
  { text: 'The fortress holds.' },
  { text: 'Keys in hand.' },
  { text: 'Invisible to the world.' },
  { text: 'Your privacy, intact.' },
  { text: 'Shields up.' },
  { text: 'All quiet on the ledger.' },
  { text: 'The archive awaits.' },
  { text: 'Onward, in silence.' },
  { text: 'The realm is still yours.' },
  { text: 'You move in shadow and mathematics.' },
  { text: 'The unexamined life is not worth living.', author: 'Socrates' },
  { text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
  { text: 'We are what we repeatedly do.', author: 'Aristotle' },
  { text: 'The only true wisdom is in knowing that you know nothing.', author: 'Socrates' },
  { text: 'It does not matter how slowly you go, as long as you do not stop.', author: 'Confucius' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'The greatest wealth is to live content with little.', author: 'Plato' },
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
  { text: 'The only constant is change.', author: 'Heraclitus' },
  { text: 'Begin at once to live, and count each separate day as a separate life.', author: 'Seneca' },
  { text: 'No man was ever wise by chance.', author: 'Seneca' },
  { text: 'Life is long if you know how to use it.', author: 'Seneca' },
  { text: 'Difficulties strengthen the mind, as labour does the body.', author: 'Seneca' },
  { text: 'Luck is what happens when preparation meets opportunity.', author: 'Seneca' },
  { text: 'Fall seven times, stand up eight.', author: 'Japanese Proverb' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Stay hungry, stay foolish.', author: 'Steve Jobs' },
  { text: 'First they ignore you, then they laugh at you, then they fight you, then you win.', author: 'Mahatma Gandhi' },
  { text: 'The time is always right to do what is right.', author: 'Martin Luther King Jr.' },
  { text: 'Quality is not an act, it is a habit.', author: 'Aristotle' },
  { text: 'A wise man should have money in his head, not in his heart.', author: 'Jonathan Swift' },
  { text: 'If money is your hope for independence you will never have it.', author: 'Henry Ford' },
  { text: 'Money is a terrible master but an excellent servant.', author: 'P.T. Barnum' },
  { text: 'Wide moats matter more than high returns.', author: 'Charlie Munger' },
  { text: 'Invert, always invert.', author: 'Charlie Munger' },
  { text: 'The market is a voting machine in the short run and a weighing machine in the long run.', author: 'Benjamin Graham' },
  { text: 'Investment is most intelligent when it is most businesslike.', author: 'Benjamin Graham' },
  { text: 'Do not spoil what you have by desiring what you have not.', author: 'Epicurus' },
  { text: 'He is a wise man who does not grieve for things he has not, but rejoices for those he has.', author: 'Epictetus' },
  { text: 'The rich ruleth over the poor, and the borrower is servant to the lender.', author: 'Proverbs 22:7' },
  { text: 'Inflation is the one form of taxation that can be imposed without legislation.', author: 'Milton Friedman' },
  { text: 'There is no such thing as a free lunch.', author: 'Milton Friedman' },
  { text: 'There is no dignity so impressive as living within your means.', author: 'Calvin Coolidge' },
  { text: 'Markets can remain irrational longer than you can remain solvent.', author: 'John Maynard Keynes' },
  { text: 'In the long run, we are all dead.', author: 'John Maynard Keynes' },
  { text: 'It is better to be roughly right than precisely wrong.', author: 'John Maynard Keynes' },
  { text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
  { text: 'I find that the harder I work, the more luck I seem to have.', author: 'Thomas Jefferson' },
  { text: 'Give me six hours to chop down a tree and I will spend four sharpening the axe.', author: 'Abraham Lincoln' },
  { text: 'No man has a good enough memory to be a successful liar.', author: 'Abraham Lincoln' },
  { text: 'All great things are simple, and many can be expressed in single words.', author: 'Winston Churchill' },
  { text: 'Success is stumbling from failure to failure with no loss of enthusiasm.', author: 'Winston Churchill' },
  { text: 'The secret of success is constancy of purpose.', author: 'Benjamin Disraeli' },
  { text: 'Those who sacrifice liberty for security deserve neither.', author: 'Benjamin Franklin' },
  { text: 'Power tends to corrupt, and absolute power corrupts absolutely.', author: 'Lord Acton' },
  { text: 'Eternal vigilance is the price of liberty.', author: 'Wendell Phillips' },
  { text: 'The truth is rarely pure and never simple.', author: 'Oscar Wilde' },
  { text: 'Experience is simply the name we give our mistakes.', author: 'Oscar Wilde' },
  { text: 'A cynic knows the price of everything and the value of nothing.', author: 'Oscar Wilde' },
  { text: 'We are all in the gutter, but some of us are looking at the stars.', author: 'Oscar Wilde' },
  { text: 'Those who cannot remember the past are condemned to repeat it.', author: 'George Santayana' },
  { text: 'Not all those who wander are lost.', author: 'J.R.R. Tolkien' },
  { text: 'All we have to decide is what to do with the time that is given us.', author: 'J.R.R. Tolkien' },
  { text: 'The measure of intelligence is the ability to change.', author: 'Albert Einstein' },
  { text: 'If you want to be happy, be.', author: 'Leo Tolstoy' },
  { text: 'Know thyself.', author: 'Socrates' },
];

let _cached: Greeting | null = null;
let _cachedMobile: Greeting | null = null;
// noAuthor=true (mobile): pick only from the short greeting variations (no author
// quotes) — the long attributed quotes look cramped on a phone.
function getGreeting(noAuthor = false): Greeting {
  if (noAuthor) {
    if (_cachedMobile) return _cachedMobile;
    const pool = GREETINGS.filter(g => !g.author);
    const stored = parseInt(sessionStorage.getItem('duelist-greeting-idx-m') ?? '', 10);
    if (!isNaN(stored) && stored >= 0 && stored < pool.length) {
      _cachedMobile = pool[stored];
      return _cachedMobile;
    }
    const i = Math.floor(Math.random() * pool.length);
    _cachedMobile = pool[i];
    sessionStorage.setItem('duelist-greeting-idx-m', String(i));
    return _cachedMobile;
  }
  if (_cached) return _cached;
  const idx = parseInt(sessionStorage.getItem('duelist-greeting-idx') ?? '', 10);
  if (!isNaN(idx) && idx >= 0 && idx < GREETINGS.length) {
    _cached = GREETINGS[idx];
    return _cached;
  }
  const newIdx = Math.floor(Math.random() * GREETINGS.length);
  _cached = GREETINGS[newIdx];
  sessionStorage.setItem('duelist-greeting-idx', String(newIdx));
  return _cached;
}

/* ── Injected sidebar CSS (hover states, logo filter, avatar) ── */
const SIDEBAR_CSS = `
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 14px 3px 20px;
    margin: 2px 8px;
    border-radius: 8px;
    text-decoration: none !important;
    color: #1a1a1a;
    font-size: 14.2px;
    letter-spacing: -0.014em;
    line-height: 1.2;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-weight: 400;
    transition: background 0.13s ease, color 0.13s ease;
    cursor: pointer;
  }
  .nav-item.active {
    background: #eeece8;
    color: #111111;
    font-weight: 400;
    text-decoration: none !important;
  }
  .nav-item.active img {
    opacity: 0.85;
  }
  .nav-item img {
    opacity: 0.75;
    flex-shrink: 0;
    transition: opacity 0.13s;
  }

  /* Logo: plain black, no hover effects */
  .sidebar-logo {
    display: block;
    width: 56px;
    height: 56px;
    cursor: default;
    filter: brightness(0.1);
  }

  /* Logout button */
  .logout-btn {
    background: transparent;
    border: 1px solid var(--border);
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    transition: background 0.13s;
  }

  /* Docs external link */
  .docs-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 14px 3px 20px;
    margin: 2px 8px;
    border-radius: 8px;
    text-decoration: none !important;
    color: #1a1a1a;
    font-size: 14.2px;
    letter-spacing: -0.014em;
    line-height: 1.2;
    font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-weight: 400;
    transition: background 0.13s ease, color 0.13s ease;
  }
  .docs-link img {
    opacity: 0.75;
    flex-shrink: 0;
  }

  /* Hover effects ONLY on devices with a real pointer (mouse) — never on
     touch, where they stick after a tap and look broken on mobile/tablet. */
  @media (hover: hover) and (pointer: fine) {
    .nav-item:hover {
      background: #eeece8;
      color: #111111;
      text-decoration: none !important;
    }
    .nav-item:hover img { opacity: 0.85; }
    .logout-btn:hover { background: #eeece8; }
    .logout-btn:hover img { opacity: 0.8; }
    .docs-link:hover {
      background: #eeece8;
      color: #111111;
      text-decoration: none !important;
    }
    .docs-link:hover img { opacity: 0.85; }
    .tx-link:hover { text-decoration: underline !important; }
  }
`;

/* ── Wallet avatar — soft blob identicon ── */
function hashAddress(addr: string): number[] {
  const seed = addr.toLowerCase().split('').map(c => c.charCodeAt(0));
  const out: number[] = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed[i]) | 0;
    out.push(h);
  }
  while (out.length < 48) {
    const last = out[out.length - 1];
    out.push(((last << 5) - last + out.length) | 0);
  }
  return out;
}

function WalletAvatar({ address, dark }: { address: string; dark: boolean }) {
  const DISPLAY = 38;
  const VIEW = 100;

  const h = hashAddress(address);
  const u = (i: number) => (Math.abs(h[i % h.length]) % 1000) / 1000;
  const n = (i: number, max: number) => Math.abs(h[i % h.length]) % max;

  const id = 'av' + address.slice(1, 9);
  const baseHue = n(0, 360);

  const bgColor = dark
    ? `hsl(${baseHue}, 40%, 11%)`
    : `hsl(${baseHue}, 30%, 88%)`;
  const blobLightness = dark ? 58 : 44;
  const blobSaturation = dark ? 82 : 70;

  const blobs = [
    { cx: 15 + u(1) * 55, cy: 15 + u(2) * 55, r: 34 + u(3) * 26, hue: baseHue },
    { cx: 15 + u(4) * 55, cy: 15 + u(5) * 55, r: 30 + u(6) * 30, hue: (baseHue + 120 + n(7, 40) - 20 + 360) % 360 },
    { cx: 15 + u(8) * 55, cy: 15 + u(9) * 55, r: 26 + u(10) * 32, hue: (baseHue + 240 + n(11, 40) - 20 + 360) % 360 },
  ];

  return (
    <svg
      width={DISPLAY} height={DISPLAY}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      style={{ borderRadius: '50%', flexShrink: 0, display: 'block' }}
    >
      <defs>
        <clipPath id={`cp${id}`}><circle cx="50" cy="50" r="50" /></clipPath>
        <filter id={`bl${id}`} colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <radialGradient id={`vg${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="50%" stopColor="black" stopOpacity="0" />
          <stop offset="100%" stopColor="black" stopOpacity={dark ? 0.5 : 0.12} />
        </radialGradient>
      </defs>
      <g clipPath={`url(#cp${id})`}>
        <rect width={VIEW} height={VIEW} fill={bgColor} />
        {blobs.map((b, i) => (
          <circle
            key={i}
            cx={b.cx} cy={b.cy} r={b.r}
            fill={`hsl(${b.hue}, ${blobSaturation}%, ${blobLightness}%)`}
            filter={`url(#bl${id})`}
            opacity={0.88}
          />
        ))}
        <circle cx="50" cy="50" r="50" fill={`url(#vg${id})`} />
      </g>
    </svg>
  );
}

/* ── Disconnect confirmation modal ── */
function DisconnectModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--surface)', borderRadius: 20, padding: 28,
          width: '90%', maxWidth: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
          border: '1px solid var(--border)',
          animation: 'pageFadeIn 0.18s ease forwards',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ fontFamily: "'Crimson Pro', serif", fontSize: 24, fontWeight: 400, marginBottom: 10 }}>
          Disconnect wallet?
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 24, lineHeight: 1.6 }}>
          Your shielded keys will be cleared from this session. Reconnect the same Stellar account to restore access instantly — no recovery phrase needed.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{ ...btnSecondary, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} style={{ ...btnDanger, flex: 1, background: 'var(--red)', color: '#fff', border: 'none' }}>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

const mainNavItems = [
  { to: '/', label: 'Portfolio', icon: walletIcon, end: true },
  { to: '/deposit', label: 'Deposit', icon: depositIcon },
  { to: '/receive', label: 'Receive', icon: receiveIcon },
  { to: '/send', label: 'Send', icon: sendIcon },
  { to: '/withdraw', label: 'Withdraw', icon: withdrawIcon },
  { to: '/history', label: 'History', icon: historyIcon },
];

const workspaceNavItems = [
  { to: '/payroll', label: 'Payroll', icon: payrollIcon },
];


export function Layout({ children }: { children: ReactNode }) {
  const w = useWallet();
  const navigate = useNavigate();
  const { dark } = useDarkMode();
  const vp = useViewport();
  const compact = vp.isCompact; // mobile or tablet — sidebar becomes a drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const greet = getGreeting(vp.isMobile);

  const handleDisconnect = () => {
    w.resetWallet();
    setShowDisconnect(false);
    navigate('/setup');
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex' }}>
      <style>{SIDEBAR_CSS}</style>

      {/* Mobile/tablet top bar — only when the sidebar is collapsed into a drawer */}
      {compact && (
        <header style={{
          // taller + safe-area inset so the logo clears the phone status bar / notch
          // (in standalone PWA mode the web content sits under the status bar).
          position: 'fixed', top: 0, left: 0, right: 0,
          height: 'calc(52px + env(safe-area-inset-top, 0px))',
          // NOTE: use paddingLeft/Right (NOT the `padding` shorthand) so the
          // safe-area paddingTop survives — a `padding:'0 16px'` shorthand would
          // reset padding-top to 0 and the icons would sit under the iOS status bar.
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 2px)',
          paddingLeft: 16, paddingRight: 16,
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          zIndex: 95,
        }}>
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 8, padding: 8, display: 'flex', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--text)" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <img src={logoSrc} alt="Duelist" className="sidebar-logo" style={{ width: 38, height: 38 }} />
        </header>
      )}

      {/* Drawer scrim */}
      {compact && drawerOpen && (
        <div
          onClick={closeDrawer}
          style={{
            position: 'fixed', inset: 0, zIndex: 105,
            background: 'rgba(0,0,0,0.32)',
            backdropFilter: 'blur(2px)',
            animation: 'fadeIn 0.18s ease forwards',
          }}
        />
      )}

      {/* Sidebar (fixed on desktop, slide-in drawer on compact) */}
      <aside
        onClick={() => { if (compact) closeDrawer(); }}
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0,
          width: compact ? 'min(var(--sidebar-w), 84vw)' : 'var(--sidebar-w)',
          background: 'var(--sidebar-bg)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          zIndex: compact ? 110 : 100,
          transform: compact && !drawerOpen ? 'translateX(-102%)' : 'translateX(0)',
          transition: 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1)',
          boxShadow: compact && drawerOpen ? '0 0 40px rgba(0,0,0,0.18)' : 'none',
      }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 14px 22px' }}>
          <img src={logoSrc} alt="Duelist" className="sidebar-logo" />
        </div>

        {/* Main nav */}
        <nav style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
          {(w.shieldedAddress || w.isRestoringSession) ? (
            <>
              {mainNavItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={(item as any).end}
                  className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
                >
                  <img src={item.icon} width={16} height={16} />
                  {item.label}
                </NavLink>
              ))}

              <div style={{
                padding: '18px 26px 6px',
                fontSize: 11, fontWeight: 400,
                color: 'var(--muted2)',
                letterSpacing: '0.01em',
                fontFamily: "'Geist', sans-serif",
              }}>
                Workspace
              </div>

              {workspaceNavItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
                >
                  <img src={item.icon} width={16} height={16} />
                  {item.label}
                </NavLink>
              ))}
            </>
          ) : (
            <NavLink to="/setup" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
              <img src={piggyIcon} width={16} height={16} />
              Get Started
            </NavLink>
          )}
        </nav>

        {/* Bottom nav */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, paddingBottom: 4 }}>
          <NavLink
            to="/settings"
            className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
          >
            <img src={settingsIcon} width={16} height={16} />
            Settings
          </NavLink>
          <a
            href="https://duelist.gitbook.io"
            target="_blank"
            rel="noopener noreferrer"
            className="docs-link"
          >
            <img src={bookIcon} width={16} height={16} />
            Docs
          </a>
        </div>

        {/* Account bar */}
        {w.stellarAddress && (
          <div style={{
            borderTop: '1px solid var(--border)',
            padding: '14px 20px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <WalletAvatar address={w.stellarAddress} dark={dark} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                onClick={() => {
                  navigator.clipboard.writeText(w.stellarAddress ?? '');
                  toast.success('Address copied');
                }}
                title={w.stellarAddress}
                style={{
                  fontSize: 14.5, fontWeight: 400, color: 'var(--text)',
                  fontFamily: "'Geist Mono', monospace",
                  overflow: 'hidden', whiteSpace: 'nowrap',
                  paddingTop: 3.5,
                  cursor: 'pointer',
                }}
              >
                {w.stellarAddress.slice(0, 8)}…{w.stellarAddress.slice(-5)}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted2)', fontFamily: "'Geist', sans-serif", marginTop: -3 }}>
                Personal Account
              </div>
            </div>
            <button
              onClick={() => setShowDisconnect(true)}
              title="Disconnect"
              className="logout-btn"
            >
              <img src={logoutIcon} alt="logout" width={15} height={15} style={{ opacity: 0.45 }} />
            </button>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main style={{
        flex: 1,
        minWidth: 0, // allow the flex item to shrink below its content's intrinsic
                     // width so wide children (charts, button rows) wrap instead of
                     // forcing horizontal overflow on narrow screens.
        marginLeft: compact ? 0 : 'var(--sidebar-w)',
        minHeight: '100vh',
        background: 'var(--bg)',
        overflowX: 'hidden',
      }}>
        <div style={{
          maxWidth: 1020,
          width: '100%',
          margin: '0 auto',
          padding: compact
            // top clears the header (52px) + the status-bar safe-area inset
            ? (vp.isMobile
                ? 'calc(70px + env(safe-area-inset-top, 0px)) 20px 32px'
                : 'calc(74px + env(safe-area-inset-top, 0px)) 28px 36px')
            : '56px 44px 40px',
        }}>
          <h1 style={{
            fontFamily: "'Crimson Pro', serif",
            fontSize: 24,
            fontWeight: 400,
            letterSpacing: '-0.02em',
            color: 'var(--prose)',
            marginBottom: 2.5,
            lineHeight: 1.15,
          }}>
            {greet.text}
          </h1>
          <div style={{
            fontFamily: "'Crimson Pro', serif",
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--muted)',
            marginBottom: 22,
            letterSpacing: '-0.01em',
            visibility: greet.author ? 'visible' : 'hidden',
          }}>
            {greet.author ?? ' '}
          </div>
          <div className="page-enter">
            {children}
          </div>
        </div>
      </main>

      {/* Disconnect modal */}
      {showDisconnect && (
        <DisconnectModal
          onConfirm={handleDisconnect}
          onCancel={() => setShowDisconnect(false)}
        />
      )}
    </div>
  );
}

/* ── Shared style exports ── */

export const btnPrimary: React.CSSProperties = {
  background: 'var(--green)',
  color: '#ffffff',
  border: 'none',
  padding: '11px 22px',
  borderRadius: 10,
  fontWeight: 400,
  fontSize: 14,
  fontFamily: "'Geist', sans-serif",
  cursor: 'pointer',
};

export const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  padding: '10px 20px',
  borderRadius: 10,
  fontWeight: 400,
  fontSize: 14,
  fontFamily: "'Geist', sans-serif",
  cursor: 'pointer',
};

export const btnDanger: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--red)',
  border: '1px solid var(--red)',
  padding: '10px 20px',
  borderRadius: 10,
  fontWeight: 400,
  fontSize: 14,
  fontFamily: "'Geist', sans-serif",
  cursor: 'pointer',
};

export const cardClass = 'shield-card';
export const card: React.CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border-color)',
  borderRadius: 16,
  padding: 28,
  marginBottom: 16,
  boxShadow: 'var(--card-shadow)',
};

export const heading: React.CSSProperties = {
  fontFamily: "'Crimson Pro', serif",
  fontSize: 26,
  fontWeight: 400,
  marginBottom: 10,
  marginTop: 0,
  color: 'var(--text)',
};

export const subHeading: React.CSSProperties = {
  fontSize: 13.5,
  color: 'var(--muted)',
  marginBottom: 22,
  marginTop: 0,
  lineHeight: 1.65,
};

export const label: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  fontWeight: 400,
  color: 'var(--muted2)',
  marginBottom: 6,
  letterSpacing: '0.01em',
};

export const availableBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  borderRadius: 8,
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  fontSize: 13,
  color: 'var(--muted)',
  marginBottom: 18,
};

export const feeTable: React.CSSProperties = {
  borderRadius: 8,
  border: '1px solid var(--border)',
  overflow: 'hidden',
  marginBottom: 20,
  fontSize: 13,
};

export const feeRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '9px 14px',
  borderBottom: '1px solid var(--border)',
};
