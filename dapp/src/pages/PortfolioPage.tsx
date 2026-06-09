// dapp/src/pages/portfoliopage.tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/WalletContext';
import { card, cardClass, btnPrimary, btnSecondary } from '../components/Layout';
import { useTokens } from '../hooks/TokenContext';
import { useCurrency } from '../hooks/CurrencyContext';
import { usePriceHistory, type Period } from '../hooks/usePriceHistory';
import { useDarkMode } from '../hooks/useDarkMode';
import { useViewport } from '../hooks/useViewport';
import { toast } from 'sonner';

import xlmIcon from '../assets/tokens/XLM.svg';
import usdcIcon from '../assets/tokens/USDC.svg';
import eurcIcon from '../assets/tokens/EURC.svg';
import refreshIcon from '../assets/icons/refresh-cw.svg';
import piggyIcon from '../assets/icons/piggy-bank.svg';
import sendIcon from '../assets/icons/send.svg';
import withdrawIcon from '../assets/icons/withdraw.svg';
import logoSrc from '../assets/logo2.svg';

const TOKEN_ICONS: Record<string, string> = { XLM: xlmIcon, USDC: usdcIcon, EURC: eurcIcon };

function TokenIcon({ symbol }: { symbol: string }) {
  const src = TOKEN_ICONS[symbol];
  if (src) return <img src={src} alt={symbol} width={36} height={36} className={`token-icon-${symbol.toLowerCase()}`} style={{ borderRadius: '50%', flexShrink: 0 }} />;
  const colors: Record<string, string> = { XLM: '#7c3aed', USDC: '#2563eb', EURC: '#059669' };
  const color = colors[symbol] ?? '#6b7280';
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 700,
      background: color + '22', border: `1px solid ${color}44`, color,
    }}>
      {symbol[0]}
    </div>
  );
}

function splitFiat(formatted: string): { main: string; dec: string } {
  const dotIdx = formatted.lastIndexOf('.');
  if (dotIdx === -1) return { main: formatted, dec: '' };
  return { main: formatted.slice(0, dotIdx), dec: formatted.slice(dotIdx) };
}

function useCountUp(target: number, duration = 1200, enabled = true) {
  const [value, setValue] = useState(0);
  const hasRun = useRef(false);

  useEffect(() => {
    if (!enabled || hasRun.current || target === 0) return;
    hasRun.current = true;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setValue(target * ease);
      if (t < 1) requestAnimationFrame(tick);
      else setValue(target);
    };
    requestAnimationFrame(tick);
  }, [target, duration, enabled]);

  return value;
}

/* ── Real portfolio chart ── */
function PortfolioChart({
  series,
  loading,
  error,
  isUp,
}: {
  series: number[];
  loading: boolean;
  error: string | null;
  isUp: boolean | null;
}) {
  const W = 400;
  const H = 135;

  if (loading) {
    return (
      <div className="skeleton" style={{ height: H, margin: '0', borderRadius: 0 }} />
    );
  }

  if (error || series.length < 2) {
    return (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1="0" y1={H * 0.62} x2={W} y2={H * 0.62} stroke="#6b7280" strokeWidth="1.5" opacity="0.35" />
      </svg>
    );
  }

  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const n = series.length;
  const color = isUp === null ? '#9ca3af' : isUp ? 'var(--green)' : 'var(--red)';

  const pts = series.map((v, i) => {
    const x = (i / (n - 1)) * W;
    const y = H - 4 - ((v - min) / range) * (H - 10);
    return [x, y] as [number, number];
  });

  // smooth curve using catmull-rom
  const smooth = (points: [number, number][]) => {
    if (points.length < 2) return '';
    let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const p0 = points[Math.max(0, i - 2)];
      const p1 = points[i - 1];
      const p2 = points[i];
      const p3 = points[Math.min(points.length - 1, i + 1)];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };

  const linePath = smooth(pts);
  const fillPath = linePath + ` L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: H, display: 'block' }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="portfolio-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color }} stopOpacity="0.22" />
          <stop offset="100%" style={{ stopColor: color }} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#portfolio-grad)" />
      <path d={linePath} fill="none" style={{ stroke: color }} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
    </svg>
  );
}

/* ── Placeholder chart for Yield card ── */
function PlaceholderChart() {
  const W = 400; const H = 135;
  const pts: [number, number][] = [0,8,5,12,7,3,9,6,11,4,10,8,13,7,15,10,12,16,11,18,14,17,19,16,20,18,22,19,21,23].map((v, i, a) => [
    (i / (a.length - 1)) * W,
    H - 4 - (v / 25) * (H - 10),
  ] as [number, number]);

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const fillPath = linePath + ` L${W},${H} L0,${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="yield-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9ca3af" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#9ca3af" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#yield-grad)" />
      <path d={linePath} fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
    </svg>
  );
}

const PERIODS: Period[] = ['24H', '7D', '30D'];

export function PortfolioPage() {
  const w = useWallet();
  const nav = useNavigate();
  const { tokens } = useTokens();
  const { xlmPrice, usdcPrice, eurcPrice, priceLoaded, formatFiat, refreshPrice, currency } = useCurrency();
  const { dark } = useDarkMode();
  const vp = useViewport();
  const syncing = w.isRefreshing;
  const [period, setPeriod] = useState<Period>('24H');
  const overviewRef = useRef<HTMLDivElement>(null);
  const yieldRef = useRef<HTMLDivElement>(null);
  // Actual rendered inner width of the Overview card. Drives action-button
  // sizing: a viewport-width rule can't tell that at 1024px the sidebar +
  // two-column layout squeezes this card to ~350px. Measuring the card itself
  // handles every device/orientation/sidebar combo uniformly.
  const [overviewW, setOverviewW] = useState(0);

  // Always fetch the history in USD: XLM's price *shape* is the same in every
  // currency (the currency just scales it), and USD has the most reliable,
  // fine-grained source (CoinGecko + Binance fallback). Fetching per-currency
  // gave coarse/jagged data for currencies without a Binance pair — the chart
  // is shape-only here, so USD keeps it smooth everywhere.
  const { xlmHistory, loading: chartLoading, error: chartError } = usePriceHistory(period, 'usd');

  useEffect(() => {
    if (!w.isInitializing && !w.shieldedAddress) nav('/setup');
  }, [w.isInitializing, w.shieldedAddress, nav]);

  // Track the Overview card's real inner width (content-box) so the action
  // buttons can size themselves to the space they actually have.
  useEffect(() => {
    const el = overviewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const wPx = entries[0]?.contentRect.width;
      if (wPx) setOverviewW(wPx);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w.shieldedAddress]);

  // xlm price % change over selected period
  const xlmPctChange = (() => {
    if (!xlmHistory || xlmHistory.length < 2) return null;
    const start = xlmHistory[0][1];
    const end = xlmHistory[xlmHistory.length - 1][1];
    if (!start) return null;
    return ((end - start) / start) * 100;
  })();

  const tokenRows = tokens.map(tk => {
    const raw = w.balances.get(tk.assetId) ?? 0n;
    const amt = Number(raw) / Math.pow(10, tk.decimals);
    const isXlm = tk.symbol === 'XLM';
    const rate = isXlm ? xlmPrice : tk.symbol === 'USDC' ? usdcPrice : tk.symbol === 'EURC' ? eurcPrice : 0;
    const fiatAmt = rate > 0 ? amt * rate : 0;
    const showFiat = priceLoaded && rate > 0;
    const tokenPct = isXlm ? xlmPctChange : null;
    return { ...tk, amt, fiatAmt, showFiat, tokenPct };
  });

  const totalFiat = tokenRows.reduce((sum, t) => sum + t.fiatAmt, 0);
  const animatedTotal = useCountUp(totalFiat, 1200, priceLoaded && totalFiat > 0);

  // portfolio value series: current holdings × historical price at each point
  const portfolioSeries: number[] = (() => {
    if (!xlmHistory || xlmHistory.length < 2) return [];
    const xlmBal = tokenRows.find(t => t.symbol === 'XLM')?.amt ?? 0;
    const stableBal = tokenRows
      .filter(t => t.symbol === 'USDC' || t.symbol === 'EURC')
      .reduce((s, t) => s + t.amt, 0);
    return xlmHistory.map(([, price]) => xlmBal * price + stableBal);
  })();

  // % change derived from portfolio series start → end
  const pctChange = (() => {
    if (portfolioSeries.length < 2) return null;
    const start = portfolioSeries[0];
    if (!start) return null; // zero balance → no meaningful % change
    return ((portfolioSeries[portfolioSeries.length - 1] - start) / start) * 100;
  })();

  const handleSync = async () => {
    const tid = toast.loading('Syncing…');
    try {
      await w.refresh();
      refreshPrice();
      toast.success('Sync complete', { id: tid });
    } catch (e: any) {
      toast.error(`Sync failed: ${e.message}`, { id: tid });
    }
  };

  if (w.isInitializing) {
    return (
      <div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          {/* one card on mobile (Yield is hidden there), two on desktop */}
          {(vp.isMobile ? [1] : [1, 2]).map(i => <div key={i} className="skeleton" style={{ flex: 1, height: 210, borderRadius: 12 }} />)}
        </div>
        {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8, marginBottom: 10 }} />)}
      </div>
    );
  }

  if (!w.shieldedAddress) return null;

  const { main, dec } = splitFiat(priceLoaded ? formatFiat(animatedTotal) : '—');
  // null = no data / no balance → neutral gray
  const fiatThreshold = currency.noDecimals ? 1 : 0.05;
  const isUp: boolean | null = (pctChange === null || totalFiat < fiatThreshold) ? null : pctChange >= 0;

  // responsive overview-button rules, driven by the card's *measured* inner
  // width (not the viewport) so the same logic covers a narrow phone, a
  // two-column tablet (~350px card at 1024px w/ sidebar), and wide desktop:
  //  - full  (card ≥ ~380px): original PC sizing, untouched.
  //  - sm    (card < 380px):  tablet two-column + small phones.
  //  - xs    (card < 270px):  Galaxy Z Fold / tiny phones.
  // Before the first measure, guess from the viewport so there's no big→small
  // flash (tablets/phones start at `sm`, only true desktop starts full).
  const cardW = overviewW || (vp.width > 1280 ? 420 : 320);
  const sm = cardW < 380;
  const xs = cardW < 270;
  // Only shrink/center when the CARD is narrow (phones, tablets, two-column
  // squeeze at ~1024 w/ sidebar). A wide desktop card lands on the `full` tier
  // below, which is byte-for-byte the ORIGINAL desktop styling — untouched.
  const centerActions = sm || xs;
  const iconSize = xs ? 13 : sm ? 14 : 15;

  const actionBtn: React.CSSProperties = {
    ...btnSecondary,
    // full tier === original desktop: '6px 12px' / 12 / gap 5 / radius 7.
    padding: xs ? '4px 7px' : sm ? '5px 9px' : '6px 12px',
    fontSize: xs ? 10.5 : sm ? 11 : 12,
    display: 'flex',
    alignItems: 'center',
    gap: xs ? 3 : sm ? 4 : 5,
    borderRadius: 7,
  };

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: vp.isMobile ? 'column' : 'row', gap: 14, marginBottom: 20 }}>

        {/* ── Overview card ── */}
        {/* on mobile (column flex) `flex:1 1 0` would collapse the card height to
            zero; use natural sizing + full width there. desktop (row) keeps the
            equal-width 1 1 0 behaviour, unchanged. */}
        <div ref={overviewRef} className={cardClass} style={{ ...card, flex: vp.isMobile ? '0 0 auto' : '1 1 0', width: vp.isMobile ? '100%' : undefined, marginBottom: 0, padding: '32px 32px 0', position: 'relative', overflow: 'hidden' }}>

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h2 style={{
              fontFamily: "'Crimson Pro', serif",
              fontSize: 26,
              fontWeight: 400,
              margin: 0,
              color: 'var(--text)',
              letterSpacing: '-0.02em',
            }}>
              Overview
            </h2>
            {/* Period tabs */}
            <div style={{ display: 'flex', gap: 2 }}>
              {PERIODS.map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 5,
                    fontSize: 11,
                    fontWeight: period === p ? 700 : 500,
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: "'Geist', sans-serif",
                    background: period === p ? 'var(--green-bg)' : 'transparent',
                    color: period === p ? 'var(--green-dark)' : 'var(--muted2)',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Balance + % change */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              {/* Proportional figures on the hero number: tabular-nums boxes the narrow
                  "1" into a wide cell and reads gappy ("$1 0 1"). Proportional sits tight.
                  Font still shrinks as the number grows so big amounts don't overflow. */}
              <div style={{ fontSize: main.length > 12 ? 28 : main.length > 9 ? 32 : 38, fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1, color: 'var(--text)', display: 'flex', alignItems: 'baseline', gap: 1 }}>
                <span>{main}</span>
                <span style={{ color: 'var(--muted2)', fontSize: main.length > 12 ? 17 : main.length > 9 ? 19 : 22, fontWeight: 400 }}>{dec}</span>
              </div>
              {pctChange !== null && totalFiat >= (fiatThreshold) && (
                <span style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: isUp === true ? 'var(--green-dark)' : isUp === false ? 'var(--red)' : 'var(--muted)',
                  background: isUp === true ? 'var(--green-bg)' : isUp === false ? 'rgba(239,68,68,0.08)' : 'var(--surface2)',
                  padding: '2px 8px',
                  borderRadius: 20,
                }}>
                  {isUp === true ? '+' : ''}{pctChange.toFixed(2)}%
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>Total shielded value · {period}</div>
          </div>

          {/* Real portfolio chart */}
          <div style={{ margin: '0 -32px', position: 'relative' }}>
            <PortfolioChart series={totalFiat < fiatThreshold ? [] : portfolioSeries} loading={chartLoading} error={chartError} isUp={isUp} />
            <img src={logoSrc} alt="" aria-hidden style={{
              position: 'absolute', bottom: 6, right: 18,
              width: 160, opacity: 0.13, pointerEvents: 'none', userSelect: 'none',
              filter: isUp === null
                ? 'brightness(0) saturate(0%) invert(60%)'
                : isUp
                  ? 'brightness(0) saturate(100%) invert(49%) sepia(80%) saturate(500%) hue-rotate(95deg) brightness(0.95)'
                  : 'brightness(0) saturate(100%) invert(42%) sepia(90%) saturate(600%) hue-rotate(320deg) brightness(1.0)',
            }} />
          </div>

          {/* Actions — trim the row's horizontal inset on narrow cards (the
              card already adds 32px each side; doubling it is what pushes the
              4th button out on tablet two-column layouts). */}
          <div style={{ display: 'flex', gap: xs ? 5 : 6, padding: xs ? '14px 12px 18px' : sm ? '16px 18px 20px' : '16px 32px 20px', alignItems: 'center', justifyContent: centerActions ? 'center' : undefined }}>
            <button style={{ ...actionBtn, background: 'var(--green)', color: '#fff', border: 'none', flexShrink: 0 }} onClick={() => nav('/deposit')}>
              <img src={piggyIcon} width={iconSize} height={iconSize} style={{ filter: 'brightness(0) invert(1)' }} />
              Deposit
            </button>
            <button style={{ ...actionBtn, flexShrink: 0 }} onClick={() => nav('/send')}>
              <img src={sendIcon} width={iconSize} height={iconSize} style={{ opacity: dark ? 0.85 : 0.6, filter: dark ? 'invert(1)' : undefined }} />
              Send
            </button>
            <button style={{ ...actionBtn, flexShrink: 0 }} onClick={() => nav('/withdraw')}>
              <img src={withdrawIcon} width={iconSize} height={iconSize} style={{ opacity: dark ? 0.85 : 0.6, filter: dark ? 'invert(1)' : undefined }} />
              Withdraw
            </button>
            <button
              style={{ ...actionBtn, padding: xs ? '4px 6px' : sm ? '5px 7px' : '6px 8px', marginLeft: centerActions ? 0 : 'auto', flexShrink: 0 }}
              onClick={handleSync} disabled={syncing} title="Refresh"
            >
              <img src={refreshIcon} width={iconSize} height={iconSize} style={{ opacity: dark ? 0.8 : 0.5, filter: dark ? 'invert(1)' : undefined, animation: w.isRefreshing ? 'spin 0.7s linear infinite' : 'none' }} />
            </button>
          </div>
        </div>

        {/* ── Yield card (placeholder) — hidden on phones to save vertical space;
            unchanged on desktop/tablet. ── */}
        {!vp.isMobile && (
        <div ref={yieldRef} className={cardClass} style={{ ...card, flex: '1 1 0', marginBottom: 0, padding: '32px 32px 0', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <h2 style={{
              fontFamily: "'Crimson Pro', serif",
              fontSize: 26,
              fontWeight: 400,
              margin: 0,
              color: 'var(--muted)',
              letterSpacing: '-0.02em',
            }}>
              Yield
            </h2>
            <span style={{ fontFamily: "'Crimson Pro', serif", fontSize: 16, color: 'var(--muted2)', fontWeight: 400 }}>(soon)</span>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1, color: 'var(--muted2)' }}>—</div>
            <div style={{ fontSize: 12, color: 'var(--muted2)', marginTop: 5 }}>Shielded yield strategies</div>
          </div>
          <div style={{ margin: '0 -32px', position: 'relative' }}>
            <PlaceholderChart />
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '16px 32px 20px' }}>
            <button style={{ ...actionBtn, opacity: 0.35, cursor: 'not-allowed' }} disabled>Stake</button>
            <button style={{ ...actionBtn, opacity: 0.35, cursor: 'not-allowed' }} disabled>Unstake</button>
          </div>
        </div>
        )}
      </div>

      {/* Portfolio section */}
      <h2 style={{
        fontFamily: "'Crimson Pro', serif",
        fontSize: 26,
        fontWeight: 400,
        margin: '0 0 12px',
        color: 'var(--text)',
        letterSpacing: '-0.02em',
      }}>
        Portfolio
      </h2>

      <div className={cardClass} style={{ ...card, padding: '4px 0' }}>
        {tokenRows.map((tk, idx) => (
          <div key={tk.assetId} style={{
            display: 'flex', alignItems: 'center', gap: vp.isMobile ? 10 : 14,
            padding: vp.isMobile ? '16px 18px' : '18px 28px',
            borderBottom: idx < tokenRows.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <TokenIcon symbol={tk.symbol} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 400, color: 'var(--text)', letterSpacing: '-0.014em' }}>{tk.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{tk.symbol}</div>
            </div>

            {/* % change badge */}
            {tk.tokenPct !== null && tk.fiatAmt >= (fiatThreshold) ? (
              <div style={{
                fontSize: 12.5, fontWeight: 400, minWidth: vp.isMobile ? 0 : 60, textAlign: 'right',
                color: tk.tokenPct >= 0 ? 'var(--green-dark)' : 'var(--red)',
              }}>
                {tk.tokenPct >= 0 ? '+' : ''}{tk.tokenPct.toFixed(2)}%
              </div>
            ) : <div style={{ minWidth: vp.isMobile ? 0 : 60 }} />}

            <div style={{ textAlign: 'right', minWidth: vp.isMobile ? 92 : 110 }}>
              {tk.showFiat && tk.fiatAmt >= (fiatThreshold) ? (
                <>
                  <div style={{ fontSize: 16, fontWeight: 400, color: 'var(--text)', display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline' }}>
                    {(() => { const { main, dec } = splitFiat(formatFiat(tk.fiatAmt)); return <><span>{main}</span><span style={{ color: 'var(--muted2)', fontSize: 13, fontWeight: 400 }}>{dec}</span></>; })()}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                    {tk.amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span style={{ color: 'var(--muted2)', marginLeft: 4 }}>{tk.symbol}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 16, fontWeight: tk.amt > 0 ? 600 : 400, color: tk.amt > 0 ? 'var(--text)' : 'var(--muted2)' }}>
                  {tk.amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  <span style={{ color: 'var(--muted2)', fontSize: 13, fontWeight: 400, marginLeft: 4 }}>{tk.symbol}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
