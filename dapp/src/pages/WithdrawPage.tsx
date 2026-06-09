import { extractErrorMsg } from '../lib/errorMsg';
// dapp/src/pages/withdrawpage.tsx
import { useState } from 'react';
import { rpc } from '@stellar/stellar-sdk';
import { useWallet } from '../hooks/WalletContext';
import { NETWORK } from '../lib/config';
import { relayWithdraw, pollTx, syncPoolRoot, preSyncPoolRoot } from '../lib/relay';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label, availableBar, feeTable, feeRow } from '../components/Layout';

import { useTokens } from '../hooks/TokenContext';
import { useCurrency } from '../hooks/CurrencyContext';
import { toast } from 'sonner';

import withdrawIcon from '../assets/icons/withdraw.svg';

const PROTOCOL_FEE_BPS = 25n;
const RELAY_FEE = 10_000_000n; // 1.0 units (7-decimal tokens) — single relay fee per tx; must match relayer + on-chain relay_fee_min
const MAX_INPUT_NOTES = 16;   // large-bucket cap: notes consolidated per withdrawal

function protocolFee(amtStroops: bigint): bigint {
  return (amtStroops * PROTOCOL_FEE_BPS + 9999n) / 10000n; // ceil(0.25%)
}
function computeWithdrawFee(amtStroops: bigint): bigint {
  return protocolFee(amtStroops) + RELAY_FEE;
}

// max receivable in one transaction: the largest <=16 notes, minus fees.
// solve w + ceil(0.25% w) + relay <= s => w <= (s - relay) * 10000 / 10025.
function maxWithdrawableFrom(noteAmounts: bigint[]): bigint {
  const capped = [...noteAmounts].sort((a, b) => Number(b - a)).slice(0, MAX_INPUT_NOTES);
  const S = capped.reduce((s, v) => s + v, 0n);
  if (S <= RELAY_FEE) return 0n;
  const max = ((S - RELAY_FEE) * 10000n - 9999n) / 10025n;
  return max > 0n ? max : 0n;
}

export function WithdrawPage() {
  const w = useWallet();
  if (w.isInitializing) return null;
  const { tokens } = useTokens();
  const [selectedTokenId, setSelectedTokenId] = useState(tokens[0].assetId);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  // Rate frozen at submit so amounts don't re-derive from a live price refresh mid-tx.
  const [frozenRate, setFrozenRate] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [addrError, setAddrError] = useState(false);

  const selectedToken = tokens.find(t => t.assetId === selectedTokenId) || tokens[0];
  const dec = selectedToken.decimals;
  const balance = w.balances.get(selectedTokenId) ?? 0n;
  const _assetNorm = (s: string) => s.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const _tnorm = _assetNorm(selectedTokenId);

  // single-transaction withdrawal: max receivable = largest <=16 notes minus fees.
  const _noteAmounts = [...w.ownedCommitments.values()]
    .filter(n => !n.spent && _assetNorm(n.assetId) === _tnorm)
    .map(n => BigInt(n.amount));
  const maxWithdrawable = maxWithdrawableFrom(_noteAmounts);

  const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const maxRaw = (Math.floor(Number(maxWithdrawable) / Math.pow(10, dec) * 100) / 100).toFixed(2);
  const maxDisplay = fmt2(parseFloat(maxRaw));
  const balanceDisplay = fmt2(Number(balance) / Math.pow(10, dec));
  const splitNum = (s: string) => { const i = s.lastIndexOf('.'); return i === -1 ? { int: s, dec: '' } : { int: s.slice(0, i), dec: s.slice(i) }; };

  const { xlmPrice, usdcPrice, eurcPrice, currency, priceLoaded } = useCurrency();
  const [fiatMode, setFiatMode] = useState(false);
  const [fiatInput, setFiatInput] = useState('');

  const liveRate = selectedToken.symbol === 'XLM' ? xlmPrice
    : selectedToken.symbol === 'USDC' ? usdcPrice
    : selectedToken.symbol === 'EURC' ? eurcPrice : 0;
  const tokenRate = frozenRate != null ? frozenRate : liveRate;

  const tokenAmtFromFiat = (() => {
    const f = parseFloat(fiatInput || '0');
    if (!isFinite(f) || f <= 0) return 0;
    return tokenRate > 0 ? f / tokenRate : 0;
  })();

  const effectiveAmt = fiatMode ? tokenAmtFromFiat : parseFloat(amount || '0');
  const amtStroopsPreview = effectiveAmt > 0 ? BigInt(Math.floor(effectiveAmt * Math.pow(10, dec))) : 0n;

  // single-tx fees: one protocol fee (0.25%) + one flat relay fee. always reconciles.
  const protocolFeePreview = amtStroopsPreview > 0n ? protocolFee(amtStroopsPreview) : 0n;
  const totalFeesPreview = amtStroopsPreview > 0n ? protocolFeePreview + RELAY_FEE : 0n;
  const relayFeeDisplay = fmt2(Number(RELAY_FEE) / Math.pow(10, dec));
  const protocolFeeDisplay = amtStroopsPreview > 0n
    ? fmt2(Number(protocolFeePreview) / Math.pow(10, dec))
    : '—';
  const exceedsMax = amtStroopsPreview > maxWithdrawable;

  const validateRecipient = (val: string) => {
    if (!val) return;
    if (val.startsWith('zk1') || val.startsWith('safu1')) {
      setAddrError(true);
      toast.error('Use a public G… address to withdraw. For private transfers use the Send page.');
      return;
    }
    if (!val.startsWith('G') || val.length !== 56) {
      setAddrError(true);
      toast.error('Invalid address — must be a valid 56-character Stellar address starting with G');
    } else {
      setAddrError(false);
    }
  };

  const handleWithdraw = async () => {
    if (!w.shieldedAddress || !w.stellarAddress) {
      toast.error('Wallet not ready.'); return;
    }
    if (recipient.startsWith('zk1') || recipient.startsWith('safu1')) {
      setAddrError(true);
      toast.error('Use a public G… address to withdraw. For private transfers use the Send page.'); return;
    }
    if (!recipient.startsWith('G') || recipient.length !== 56) {
      toast.error('Recipient must be a valid G… Stellar address'); return;
    }
    if (effectiveAmt <= 0) {
      toast.error('Enter the amount to withdraw'); return;
    }

    const withdrawAmount = BigInt(Math.floor(effectiveAmt * Math.pow(10, selectedToken.decimals)));
    if (withdrawAmount <= 0n) { toast.error('Amount must be positive'); return; }
    if (withdrawAmount > maxWithdrawable) { toast.error('Amount exceeds available balance (after fees)'); return; }

    const totalFee = computeWithdrawFee(withdrawAmount);

    setFrozenRate(tokenRate); setBusy(true);
    const tid = toast.loading('Syncing pool root…');
    const server = new rpc.Server(NETWORK.rpcUrl);

    try {
      await preSyncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl);

      // one transaction: prove (consolidating up to 16 notes), relay, confirm.
      setStatusMsg('Generating ZK proof…');
      toast.loading('Generating proof…', { id: tid });
      const result = await w.proveWithdraw(
        selectedTokenId, recipient.trim(),
        totalFee.toString(), withdrawAmount.toString(),
      );

      setStatusMsg('Submitting…');
      toast.loading('Submitting…', { id: tid });
      const hash = await relayWithdraw(NETWORK.relayerUrls[0], result, recipient.trim());

      setStatusMsg('Confirming…');
      await pollTx(server, hash);

      await w.refresh();
      syncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl).catch(() => {});

      toast.success('Withdrawal complete!', { id: tid });
      setTxHash(hash);
      setStatusMsg('');
    } catch (e: any) {
      let msg: string = extractErrorMsg(e);
      const codeMap: Record<string, string> = {
        '#4':  'InvalidProof — VK or public inputs mismatch',
        '#8':  'PoolRootMismatch — pool root drifted, retry',
        '#14': 'RecipientMismatch — address hash mismatch',
        '#5':  'NullifierSpent — note already spent',
        '#6':  'AssetNotAllowed',
        '#16': 'Sanctioned — recipient on sanctions list',
      };
      for (const [code, desc] of Object.entries(codeMap)) {
        if (msg.includes(code)) { msg = `Contract error ${code}: ${desc}`; break; }
      }
      toast.error(msg.length > 200 ? msg.slice(0, 200) + '…' : msg, { id: tid });
      setStatusMsg('');
    } finally {
      setBusy(false); setFrozenRate(null);
    }
  };

  const decimals = selectedToken.decimals;

  return (
    <div>
      {/* Success state */}
      {txHash && !busy && (
        <div style={{
          ...card,
          borderColor: 'var(--accent-35)',
          background: 'var(--accent-04)',
          marginBottom: 16,
        }}>
          <h2 style={{
            fontFamily: "'Crimson Pro', serif",
            fontSize: 22,
            fontWeight: 400,
            color: 'var(--green-dark)',
            marginBottom: 14,
          }}>
            Withdrawal confirmed
          </h2>
          <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Transaction</div>
          <a
            href={`${NETWORK.explorerBase}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, color: 'var(--blue-link)' }}
          >
            {txHash.slice(0, 16)}…{txHash.slice(-8)} ↗
          </a>
          <button
            style={{ ...btnSecondary, padding: '8px 16px', fontSize: 13, marginTop: 14, display: 'block' }}
            onClick={() => { setTxHash(null); setAmount(''); setRecipient(''); setAddrError(false); setFiatInput(''); setFiatMode(false); }}
          >
            New Withdrawal
          </button>
        </div>
      )}

      <div style={card} className={cardClass}>
        <h1 style={heading}>Withdraw</h1>
        <p style={subHeading}>
          Reclaim your shielded assets to any public Stellar address in a single transaction. The relayer carries the transaction forth — your wallet remains hidden behind the curtain.
        </p>

        {/* Available bar */}
        <div style={availableBar}>
          <span>Available:</span>
          <strong style={{ color: 'var(--text)', marginLeft: 4, opacity: w.isRefreshing ? 0.5 : 1, transition: 'opacity 0.3s' }}>
            {splitNum(balanceDisplay).int}<span style={{ color: 'var(--muted2)' }}>{splitNum(balanceDisplay).dec}</span> {selectedToken.symbol}
          </strong>
          <span style={{ marginLeft: 4, color: 'var(--muted2)', fontSize: 12 }}>
            ({splitNum(maxDisplay).int}<span style={{ opacity: 0.7 }}>{splitNum(maxDisplay).dec}</span> after fees)
          </span>
        </div>

        <label style={label}>Asset</label>
        <select
          value={selectedTokenId}
          onChange={e => { setSelectedTokenId(e.target.value); setFiatMode(false); setFiatInput(''); }}
          disabled={busy}
          style={{ width: '100%', marginBottom: 16 }}
        >
          {tokens.map(t => <option key={t.assetId} value={t.assetId}>{t.symbol} — {t.name}</option>)}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ ...label, marginBottom: 0 }}>Amount ({fiatMode ? currency.code.toUpperCase() : selectedToken.symbol})</span>
          {priceLoaded && tokenRate > 0 && (
            <button type="button" onClick={() => setFiatMode(m => !m)} disabled={busy}
              style={{ fontSize: 12, padding: '4px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, cursor: busy ? 'default' : 'pointer', color: 'var(--muted)', fontWeight: 400, lineHeight: 1.5, fontFamily: "'Geist', sans-serif" }}>
              {fiatMode ? `${currency.symbol} → ${selectedToken.symbol}` : `${selectedToken.symbol} → ${currency.symbol}`}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            {fiatMode && (
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted2)', fontSize: 14, pointerEvents: 'none', zIndex: 1 }}>
                {currency.symbol}
              </span>
            )}
            <input
              type="number"
              value={fiatMode ? fiatInput : amount}
              onChange={e => fiatMode ? setFiatInput(e.target.value) : setAmount(e.target.value)}
              step={fiatMode ? '0.01' : Math.pow(10, -decimals).toFixed(decimals)}
              min="0"
              placeholder={fiatMode ? '0.00' : `0.${'0'.repeat(decimals - 1)}1`}
              disabled={busy}
              style={{ width: '100%', paddingLeft: fiatMode ? (18 + currency.symbol.length * 9) : undefined, paddingRight: 32 }}
            />
            {(fiatMode ? fiatInput : amount) && (
              <button type="button" onClick={() => fiatMode ? setFiatInput('') : setAmount('')} disabled={busy}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted2)', fontSize: 18, lineHeight: 1, padding: '2px 4px' }}>
                ×
              </button>
            )}
          </div>
          <button
            style={{ ...btnSecondary, whiteSpace: 'nowrap', padding: '10px 14px', flexShrink: 0 }}
            onClick={() => {
              if (fiatMode) {
                const maxToken = Number(maxWithdrawable) / Math.pow(10, dec);
                const maxFiat = tokenRate > 0
                  ? Math.floor(maxToken * tokenRate * 100) / 100
                  : Math.floor(maxToken * 100) / 100;
                setFiatInput(maxFiat.toFixed(currency.noDecimals ? 0 : 2));
              } else {
                setAmount(maxRaw);
              }
            }}
            disabled={busy}
          >
            Max
          </button>
        </div>
        <div style={{ minHeight: 18, marginBottom: 8, fontSize: 12, color: exceedsMax ? 'var(--red)' : 'var(--muted2)' }}>
          {exceedsMax
            ? `Exceeds max single-tx withdrawal of ${maxDisplay} ${selectedToken.symbol}`
            : fiatMode && tokenAmtFromFiat > 0
            ? `≈ ${tokenAmtFromFiat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${selectedToken.symbol}`
            : !fiatMode && effectiveAmt > 0 && priceLoaded && tokenRate > 0
            ? `≈ ${currency.symbol}${(effectiveAmt * tokenRate).toLocaleString('en-US', { minimumFractionDigits: currency.noDecimals ? 0 : 2, maximumFractionDigits: currency.noDecimals ? 0 : 2 })}`
            : ''}
        </div>

        <label style={label}>Recipient public Stellar address</label>
        <input
          value={recipient}
          onChange={e => { setRecipient(e.target.value); setAddrError(false); }}
          onBlur={e => validateRecipient(e.target.value)}
          placeholder="G…"
          disabled={busy}
          style={{ marginBottom: 16, ...(addrError ? { borderColor: 'var(--red)', boxShadow: '0 0 0 3px rgba(239,68,68,0.14)' } : {}) }}
        />

        {/* Fee table */}
        <div style={{ ...feeTable, marginBottom: 20 }}>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Protocol fee (0.25%)</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {protocolFeeDisplay} {selectedToken.symbol}
            </span>
          </div>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Relay fee</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {relayFeeDisplay} {selectedToken.symbol}
            </span>
          </div>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Total deducted from shielded</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {amtStroopsPreview > 0n
                ? fmt2(Number(totalFeesPreview + amtStroopsPreview) / Math.pow(10, dec))
                : '—'} {selectedToken.symbol}
            </span>
          </div>
          <div style={{ ...feeRow, borderBottom: 'none', fontWeight: 400 }}>
            <span>You receive in wallet</span>
            <span style={{ color: amtStroopsPreview > 0n ? 'var(--green-dark)' : 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {amtStroopsPreview > 0n ? fmt2(Number(amtStroopsPreview) / Math.pow(10, dec)) : '—'} {selectedToken.symbol}
            </span>
          </div>
        </div>

        {statusMsg && (
          <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--muted)' }}>
            {statusMsg}
          </div>
        )}

        <button
          style={{
            ...btnPrimary,
            width: '100%',
            padding: '13px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 14,
          }}
          onClick={handleWithdraw}
          disabled={busy || !recipient || effectiveAmt <= 0 || exceedsMax || maxWithdrawable === 0n}
        >
          <img src={withdrawIcon} width={16} height={16} style={{ filter: 'brightness(0) invert(1)', flexShrink: 0 }} />
          {busy ? 'Working…' : 'Withdraw'}
        </button>

        <p style={{ marginTop: 14, fontSize: 12, color: 'var(--muted2)', lineHeight: 1.65, textAlign: 'center',  }}>
          Your notes are consolidated and reclaimed in one private transaction — change returns to your shielded balance automatically.
        </p>
      </div>
    </div>
  );
}
