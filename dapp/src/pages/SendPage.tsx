import { extractErrorMsg } from '../lib/errorMsg';
// dapp/src/pages/sendpage.tsx
import { useState } from 'react';
import { rpc } from '@stellar/stellar-sdk';
import { useWallet } from '../hooks/WalletContext';
import { NETWORK } from '../lib/config';
import { relayTransfer, pollTx, syncPoolRoot, preSyncPoolRoot } from '../lib/relay';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label, availableBar, feeTable, feeRow } from '../components/Layout';
import { useTokens } from '../hooks/TokenContext';
import { useCurrency } from '../hooks/CurrencyContext';
import { toast } from 'sonner';

import sendIcon from '../assets/icons/send.svg';

const RELAY_FEE_STROOPS = 10_000_000n; // 1.0 units (7-decimal tokens) — must match relayer MIN_RELAY_FEE + on-chain relay_fee_min

export function SendPage() {
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
  const maxSend = balance > RELAY_FEE_STROOPS ? balance - RELAY_FEE_STROOPS : 0n;
  const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const maxDisplay = fmt2(Number(maxSend) / Math.pow(10, dec));
  const balanceDisplay = fmt2(Number(balance) / Math.pow(10, dec));
  const splitNum = (s: string) => { const i = s.lastIndexOf('.'); return i === -1 ? { int: s, dec: '' } : { int: s.slice(0, i), dec: s.slice(i) }; };
  const relayFeeDisplay = fmt2(Number(RELAY_FEE_STROOPS) / Math.pow(10, dec));
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

  const validateRecipient = (val: string) => {
    if (val && !val.startsWith('zk1')) {
      setAddrError(true);
      toast.error('Invalid shielded address — must start with zk1');
    } else {
      setAddrError(false);
    }
  };

  const handleSend = async () => {
    if (!w.shieldedAddress || !w.stellarAddress) {
      toast.error('Wallet not ready.'); return;
    }
    if (!recipient.startsWith('zk1')) {
      setAddrError(true);
      toast.error('Recipient must be a zk1… shielded address. For public withdrawals use the Withdraw page.'); return;
    }
    const amtStroops = BigInt(Math.floor(effectiveAmt * Math.pow(10, selectedToken.decimals)));
    if (amtStroops <= 0n) { toast.error('Amount must be positive'); return; }
    if (amtStroops > maxSend) { toast.error('Amount exceeds shielded balance'); return; }

    setFrozenRate(tokenRate); setBusy(true);
    const tid = toast.loading('Syncing pool root…');
    try {
      await preSyncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl);
      toast.loading('Generating ZK proof…', { id: tid });
      setStatusMsg('Generating ZK transfer proof…');
      const result = await w.proveTransfer(recipient.trim(), selectedTokenId, amtStroops.toString(), RELAY_FEE_STROOPS.toString());

      setStatusMsg('Submitting via relayer…');
      toast.loading('Submitting via relayer…', { id: tid });
      const hash = await relayTransfer(NETWORK.relayerUrls[0], result);

      toast.loading('Waiting for confirmation…', { id: tid });
      setStatusMsg('Waiting for confirmation…');
      const server = new rpc.Server(NETWORK.rpcUrl);
      await pollTx(server, hash);

      await w.refresh();
      syncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl).catch(() => {});

      toast.success('Transfer complete!', { id: tid });
      setTxHash(hash);
      setStatusMsg('');
    } catch (e: any) {
      let msg: string = extractErrorMsg(e);
      const codeMap: Record<string, string> = {
        '#4':  'InvalidProof — VK or public inputs mismatch',
        '#8':  'PoolRootMismatch — retry',
        '#5':  'NullifierSpent — note already spent',
        '#6':  'AssetNotAllowed',
      };
      for (const [code, desc] of Object.entries(codeMap)) {
        if (msg.includes(code)) { msg = `Contract error ${code}: ${desc}`; break; }
      }
      toast.error(msg.length > 120 ? msg.slice(0, 120) + '…' : msg, { id: tid });
      setStatusMsg('');
    } finally {
      setBusy(false); setFrozenRate(null);
    }
  };

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
            Transfer confirmed
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
            onClick={() => { setTxHash(null); setAmount(''); setRecipient(''); setFiatInput(''); setFiatMode(false); }}
          >
            New Transfer
          </button>
        </div>
      )}

      <div style={card} className={cardClass}>
        <h1 style={heading}>Send</h1>
        <p style={subHeading}>
          Dispatch assets through the shielded realm to any worthy recipient. The relayer bears your transaction forward — your name never appears on the ledger.
        </p>

        {/* Available bar */}
        <div style={availableBar}>
          <span>Available:</span>
          <strong style={{ color: 'var(--text)', marginLeft: 4, opacity: w.isRefreshing ? 0.5 : 1, transition: 'opacity 0.3s' }}>
            {splitNum(balanceDisplay).int}<span style={{ color: 'var(--muted2)' }}>{splitNum(balanceDisplay).dec}</span> {selectedToken.symbol}
          </strong>
          {maxSend < balance && (
            <span style={{ marginLeft: 4, color: 'var(--muted2)', fontSize: 12 }}>
              ({splitNum(maxDisplay).int}<span style={{ color: 'var(--muted2)', opacity: 0.7 }}>{splitNum(maxDisplay).dec}</span> after relay fee)
            </span>
          )}
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
        <div style={{ position: 'relative', marginBottom: 4 }}>
          {fiatMode && (
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted2)', fontSize: 14, pointerEvents: 'none', zIndex: 1 }}>
              {currency.symbol}
            </span>
          )}
          <input
            type="number"
            value={fiatMode ? fiatInput : amount}
            onChange={e => fiatMode ? setFiatInput(e.target.value) : setAmount(e.target.value)}
            step={fiatMode ? '0.01' : '0.001'}
            min="0"
            placeholder={fiatMode ? '0.00' : `Max ${maxDisplay}`}
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
        <div style={{ minHeight: 18, marginBottom: 8, fontSize: 12, color: 'var(--muted2)' }}>
          {fiatMode && tokenAmtFromFiat > 0
            ? `≈ ${tokenAmtFromFiat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${selectedToken.symbol}`
            : !fiatMode && effectiveAmt > 0 && priceLoaded && tokenRate > 0
            ? `≈ ${currency.symbol}${(effectiveAmt * tokenRate).toLocaleString('en-US', { minimumFractionDigits: currency.noDecimals ? 0 : 2, maximumFractionDigits: currency.noDecimals ? 0 : 2 })}`
            : ''}
        </div>

        <label style={label}>Recipient's shielded address</label>
        <input
          value={recipient}
          onChange={e => { setRecipient(e.target.value); setAddrError(false); }}
          onBlur={e => validateRecipient(e.target.value)}
          placeholder="zk1…"
          disabled={busy}
          style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, marginBottom: 16, ...(addrError ? { borderColor: 'var(--red)', boxShadow: '0 0 0 3px rgba(239,68,68,0.14)' } : {}) }}
        />

        {/* Fee table */}
        <div style={{ ...feeTable, marginBottom: 20 }}>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Relay fee</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {relayFeeDisplay} {selectedToken.symbol}
            </span>
          </div>
          <div style={{ ...feeRow, borderBottom: 'none', fontWeight: 400 }}>
            <span>Total deducted from shielded</span>
            <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {effectiveAmt > 0
                ? fmt2((effectiveAmt) + Number(RELAY_FEE_STROOPS) / Math.pow(10, dec))
                : '—'} {selectedToken.symbol}
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
          onClick={handleSend}
          disabled={busy || !recipient || effectiveAmt <= 0 || maxSend === 0n}
        >
          <img src={sendIcon} width={16} height={16} style={{ filter: 'brightness(0) invert(1)', flexShrink: 0 }} />
          {busy ? 'Working…' : 'Send'}
        </button>

        <p style={{ marginTop: 14, fontSize: 12, color: 'var(--muted2)', lineHeight: 1.65, textAlign: 'center',  }}>
          Only shielded addresses (zk1…) may receive. For public withdrawals to a G… address, use the Withdraw page.
        </p>
      </div>
    </div>
  );
}
