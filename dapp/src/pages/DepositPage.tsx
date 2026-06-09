import { extractErrorMsg } from '../lib/errorMsg';
// dapp/src/pages/depositpage.tsx
import { useState } from 'react';
import { Contract, TransactionBuilder, BASE_FEE, xdr, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { useWallet } from '../hooks/WalletContext';
import { NETWORK } from '../lib/config';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label, feeTable, feeRow } from '../components/Layout';
import { useTokens } from '../hooks/TokenContext';
import { useCurrency } from '../hooks/CurrencyContext';
import { useViewport } from '../hooks/useViewport';
import { toast } from 'sonner';

import castleImg from '../assets/newcastle.svg';
import piggyIcon from '../assets/icons/piggy-bank.svg';
import checkIcon from '../assets/icons/check.svg';

const FEE_BPS = 25; // 0.25%

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '').padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const stepLabels = [
  'Generating ZK proof locally…',
  'Building Stellar transaction…',
  'Waiting for signature…',
  'Confirming on-chain…',
];

function StepProgress({ step, totalSteps }: { step: number; totalSteps: number }) {
  return (
    <div style={{ marginTop: 20, padding: '14px 16px', background: 'var(--surface2)', borderRadius: 10, border: '1px solid var(--border)' }}>
      {stepLabels.slice(0, totalSteps).map((lbl, i) => {
        const done = i + 1 < step;
        const active = i + 1 === step;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: i < totalSteps - 1 ? 10 : 0 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              background: done ? 'var(--green)' : active ? 'var(--green)' : 'var(--border)',
              color: done || active ? '#fff' : 'var(--muted)',
              transition: 'background 0.3s',
            }}>
              {done ? <img src={checkIcon} width={12} height={12} style={{ filter: 'brightness(0) invert(1)' }} /> : i + 1}
            </div>
            <span style={{ fontSize: 13, color: active ? 'var(--text)' : done ? 'var(--muted)' : 'var(--muted2)', fontWeight: active ? 600 : 400 }}>
              {lbl}
            </span>
            {active && (
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--green)', animation: 'pulse 1.5s ease-in-out infinite' }}>
                working…
              </span>
            )}
          </div>
        );
      })}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </div>
  );
}

export function DepositPage() {
  const w = useWallet();
  const vp = useViewport();
  if (w.isInitializing) return null;
  const { tokens } = useTokens();

  const [selectedTokenId, setSelectedTokenId] = useState(tokens[0].assetId);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  // Rate frozen at submit time so the displayed amounts don't re-derive from a live
  // price refresh while the tx is in flight — keeps the UI consistent with what was sent.
  const [frozenRate, setFrozenRate] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [receiptCommitment, setReceiptCommitment] = useState<string | null>(null);
  const [networkFeeXlm, setNetworkFeeXlm] = useState<number | null>(null);

  const selectedToken = tokens.find(t => t.assetId === selectedTokenId) || tokens[0];
  const { xlmPrice, usdcPrice, eurcPrice, currency, priceLoaded } = useCurrency();
  const [fiatMode, setFiatMode] = useState(false);
  const [fiatInput, setFiatInput] = useState('');

  const liveRate = selectedToken.symbol === 'XLM' ? xlmPrice
    : selectedToken.symbol === 'USDC' ? usdcPrice
    : selectedToken.symbol === 'EURC' ? eurcPrice : 0;
  // Hold the rate steady once a tx is submitted so all amounts/fees stay consistent.
  const tokenRate = frozenRate != null ? frozenRate : liveRate;

  const tokenAmtFromFiat = (() => {
    const f = parseFloat(fiatInput || '0');
    if (!isFinite(f) || f <= 0) return 0;
    return tokenRate > 0 ? f / tokenRate : 0;
  })();

  const effectiveAmt = fiatMode ? tokenAmtFromFiat : parseFloat(amount || '0');
  const feeAmt = effectiveAmt > 0 ? (effectiveAmt * FEE_BPS / 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  const netAmt = effectiveAmt > 0 ? (effectiveAmt - effectiveAmt * FEE_BPS / 10000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  const handleDeposit = async () => {
    if (!w.shieldedAddress || !w.stellarAddress) {
      toast.error('Wallet not ready. Connect and derive shielded keys first.');
      return;
    }
    const gross = BigInt(Math.floor(effectiveAmt * Math.pow(10, selectedToken.decimals)));
    if (gross <= 0n) { toast.error('Amount must be positive'); return; }

    // pre-check public wallet balance — need headroom for soroban fee on top of deposit amount
    try {
      const _horizonBase = NETWORK.rpcUrl.includes('testnet') ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org';
      const _acctResp = await fetch(`${_horizonBase}/accounts/${w.stellarAddress}`);
      const _acct = await _acctResp.json();
      const _xlmBal = BigInt(Math.round(parseFloat((_acct.balances ?? []).find((b: any) => b.asset_type === 'native')?.balance ?? '0') * 1e7));
      const _MIN_HEADROOM = 15_000_000n; // 1.5 XLM: 1 XLM min account reserve + 0.5 XLM Soroban fee buffer
      if (gross + _MIN_HEADROOM > _xlmBal) {
        const avail = (Math.floor(Math.max(0, Number(_xlmBal) / 1e7 - 1.5) * 100) / 100).toFixed(2);
        toast.error(`Insufficient public wallet balance. You can deposit at most ${avail} ${selectedToken.symbol} (1.5 XLM reserved for network fees & account reserve).`);
        return;
      }
    } catch { /* ignore pre-check errors, let deposit attempt surface the real error */ }

    setFrozenRate(tokenRate); setBusy(true); setStep(1);
    const tid = toast.loading('Generating ZK proof…');

    try {
      const result = await w.proveDeposit(selectedToken.assetId, gross.toString(), FEE_BPS);

      setStep(2); toast.loading('Building transaction…', { id: tid });
      const proofBytes = new Uint8Array(result.proofBytes);
      const ciphertext  = new Uint8Array(result.encryptedCiphertext);
      const ephemeralPk = new Uint8Array(result.encryptedEphemeralPk);
      const commitment  = hexToBytes32(result.commitment);
      const assetIdBytes = hexToBytes32(selectedToken.assetId);

      const server  = new rpc.Server(NETWORK.rpcUrl);
      const account = await server.getAccount(w.stellarAddress);
      const contract = new Contract(NETWORK.poolContract);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK.networkPassphrase,
      })
        .addOperation(contract.call(
          'deposit',
          nativeToScVal(w.stellarAddress, { type: 'address' }),
          xdr.ScVal.scvBytes(Buffer.from(assetIdBytes)),
          nativeToScVal(gross, { type: 'i128' }),
          xdr.ScVal.scvBytes(Buffer.from(commitment)),
          xdr.ScVal.scvBytes(Buffer.from(proofBytes)),
          xdr.ScVal.scvBytes(Buffer.from(ciphertext)),
          xdr.ScVal.scvBytes(Buffer.from(ephemeralPk)),
        ))
        .setTimeout(60)
        .build();

      let prepared: any;
      try {
        prepared = await server.prepareTransaction(tx);
      } catch (simErr: any) {
        // preparetransaction throws simulatetransactionerrorresponse — error string is at .error
        const detail = simErr?.error ?? simErr?.message ?? String(simErr);
        console.error('Soroban simulation failed:', simErr);
        throw new Error(`Simulation failed: ${detail}`);
      }

      // show actual soroban network fee before user signs
      const sorobanFeeXlm = parseInt(prepared.fee) / 1e7;
      setNetworkFeeXlm(sorobanFeeXlm);

      setStep(3); toast.loading('Waiting for signature…', { id: tid });
      const signedXdr = await w.signXdr(prepared.toXDR());
      const signedTx  = TransactionBuilder.fromXDR(signedXdr, NETWORK.networkPassphrase);

      setStep(4); toast.loading('Submitting to network…', { id: tid });
      const sendResp = await server.sendTransaction(signedTx);
      if (sendResp.status === 'ERROR') throw new Error(`Submit failed: ${JSON.stringify(sendResp.errorResult)}`);

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await server.getTransaction(sendResp.hash);
        if (res.status === 'SUCCESS') {
          toast.loading('Deposit confirmed! Syncing pool root…', { id: tid });
          await new Promise(r => setTimeout(r, 8000));
          await w.refresh();

          try {
            const relayerUrl = NETWORK.relayerUrls[0];
            if (relayerUrl) {
              const rootResp = await fetch(`${relayerUrl}/relay/update-root`, { method: 'POST' });
              if (rootResp.ok) {
                const { hash } = await rootResp.json();
                for (let j = 0; j < 20; j++) {
                  await new Promise(r => setTimeout(r, 2000));
                  const rootRes = await server.getTransaction(hash);
                  if (rootRes.status === 'SUCCESS') break;
                  if (rootRes.status === 'FAILED') { console.warn('Pool root tx failed'); break; }
                }
              }
            }
          } catch (rootErr) {
            console.warn('Pool root update skipped:', rootErr);
          }

          toast.success('Deposit complete!', { id: tid });
          setTxHash(sendResp.hash);
          setReceiptCommitment(result.commitment);
          setStep(0); return;
        }
        if (res.status === 'FAILED') throw new Error('Transaction failed on-chain');
      }
      throw new Error('Transaction timed out — check explorer for status');
    } catch (e: any) {
      let msg: string = extractErrorMsg(e);
      if (msg.includes('#2') || msg.includes('insufficient') || msg.toLowerCase().includes('balance')) {
        msg = `Insufficient public wallet balance — ensure your Stellar account has enough ${selectedToken.symbol} plus ~1 XLM for network fees.`;
      } else if (msg.length > 160) {
        msg = msg.slice(0, 160) + '…';
      }
      toast.error(msg, { id: tid });
      setStep(0);
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
            Deposit confirmed
          </h2>
          <div style={{ marginBottom: receiptCommitment ? 12 : 0 }}>
            <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Transaction</div>
            <a
              href={`${NETWORK.explorerBase}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, color: 'var(--blue-link)', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              {txHash.slice(0, 16)}…{txHash.slice(-8)} ↗
            </a>
          </div>
          {receiptCommitment && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Commitment (receipt)</div>
              <div
                onClick={() => { navigator.clipboard.writeText(receiptCommitment!); toast.success('Commitment copied'); }}
                title={receiptCommitment}
                style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all', cursor: 'pointer' }}
              >
                {receiptCommitment.slice(0, 20)}…{receiptCommitment.slice(-8)}
              </div>
            </div>
          )}
          <button
            style={{ ...btnSecondary, padding: '8px 16px', fontSize: 13 }}
            onClick={() => { setTxHash(null); setReceiptCommitment(null); setAmount(''); setFiatInput(''); setFiatMode(false); }}
          >
            New Deposit
          </button>
        </div>
      )}

      {/* Main card — two-column: form left, castle+button right */}
      <div className={cardClass} style={{ ...card, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: vp.isCompact ? 'column' : 'row', alignItems: 'stretch', position: 'relative' }}>

        {/* Castle watermark — anchored to full card bottom-right */}
        <img
          src={castleImg}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            bottom: -8,
            right: -48,
            width: '58%',
            height: 'auto',
            opacity: 0.28,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />

        {/* Left: form */}
        <div style={{ flex: 1, padding: 28, minWidth: 0, position: 'relative', zIndex: 1 }}>
          <h1 style={heading}>Deposit</h1>
          <p style={{ ...subHeading, fontSize: vp.isMobile ? 12 : subHeading.fontSize }}>
            Cast your assets into the shielded realm. Your ZK proof is forged locally inside your browser, and only you hold the key to what lies within.
          </p>

          <label style={label}>Asset</label>
          <select
            value={selectedTokenId}
            onChange={e => { setSelectedTokenId(e.target.value); setFiatMode(false); setFiatInput(''); }}
            disabled={busy}
            style={{ width: '100%', marginBottom: 16 }}
          >
            {tokens.map(t => (
              <option key={t.assetId} value={t.assetId}>{t.symbol} — {t.name}</option>
            ))}
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
              onChange={e => { setNetworkFeeXlm(null); fiatMode ? setFiatInput(e.target.value) : setAmount(e.target.value); }}
              step={fiatMode ? '0.01' : '0.001'}
              min="0"
              placeholder={fiatMode ? '0.00' : '0.001'}
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
          <div style={{ minHeight: 18, marginBottom: 10, fontSize: 12, color: 'var(--muted2)' }}>
            {fiatMode && tokenAmtFromFiat > 0
              ? `≈ ${tokenAmtFromFiat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${selectedToken.symbol}`
              : !fiatMode && effectiveAmt > 0 && priceLoaded && tokenRate > 0
              ? `≈ ${currency.symbol}${(effectiveAmt * tokenRate).toLocaleString('en-US', { minimumFractionDigits: currency.noDecimals ? 0 : 2, maximumFractionDigits: currency.noDecimals ? 0 : 2 })}`
              : ''}
          </div>

          {effectiveAmt > 0 && (
            <div style={{ ...feeTable, marginBottom: 0 }}>
              <div style={feeRow}>
                <span style={{ color: 'var(--muted)' }}>Deposit amount</span>
                <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
                  {effectiveAmt.toLocaleString('en-US', { maximumFractionDigits: 4 })} {selectedToken.symbol}
                </span>
              </div>
              <div style={feeRow}>
                <span style={{ color: 'var(--muted)' }}>Protocol fee (0.25%)</span>
                <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
                  −{feeAmt} {selectedToken.symbol}
                </span>
              </div>
              <div style={feeRow}>
                <span style={{ color: 'var(--muted)' }}>
                  Network fee (gas)
                  {!networkFeeXlm && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>(shown after proof)</span>}
                </span>
                <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
                  {networkFeeXlm != null ? `~${networkFeeXlm.toFixed(4)} XLM` : '—'}
                </span>
              </div>
              <div style={feeRow}>
                <span>You receive (shielded)</span>
                <span style={{ color: 'var(--green-dark)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
                  {netAmt} {selectedToken.symbol}
                </span>
              </div>
              {/* what actually leaves the public wallet: the deposit principal in the
                  asset + the XLM gas (combined when the asset IS XLM) — shown as the
                  prominent headline total. */}
              <div style={{ ...feeRow, borderBottom: 'none', fontWeight: 600 }}>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>Deducted from wallet</span>
                <span style={{ color: 'var(--text)', fontWeight: 600, fontFamily: "'Geist Mono', monospace", fontSize: 12.5 }}>
                  {selectedToken.symbol === 'XLM'
                    ? `${(effectiveAmt + (networkFeeXlm ?? 0)).toLocaleString('en-US', { maximumFractionDigits: 4 })} XLM`
                    : `${effectiveAmt.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${selectedToken.symbol}${networkFeeXlm != null ? ` + ${networkFeeXlm.toFixed(4)} XLM` : ''}`}
                </span>
              </div>
            </div>
          )}

          {!w.shieldedAddress && w.stellarAddress && (
            <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--orange)', fontSize: 13 }}>
              Shielded keys not derived yet. Go to Setup to derive your keys.
            </div>
          )}

          {busy && step > 0 && <StepProgress step={step} totalSteps={4} />}
        </div>

        {/* Right: deposit button */}
        <div style={{
          width: vp.isCompact ? '100%' : 300,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: vp.isCompact ? 'stretch' : 'flex-end',
          padding: vp.isCompact ? '0 28px 28px' : 24,
          position: 'relative',
          zIndex: 1,
        }}>
          <button
            style={{
              ...btnPrimary,
              padding: '12px 28px',
              fontSize: 15,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              flexShrink: 0,
              width: vp.isCompact ? '100%' : undefined,
            }}
            onClick={handleDeposit}
            disabled={busy || !w.stellarAddress || !w.shieldedAddress || effectiveAmt <= 0}
          >
            <img src={piggyIcon} width={16} height={16} style={{ filter: 'brightness(0) invert(1)', flexShrink: 0 }} />
            {busy ? 'Working…' : 'Deposit'}
          </button>
        </div>
      </div>

      {/* Text below — Crimson Pro, no em dashes */}
      <div style={{ paddingTop: 20 }}>
        <p style={{
          fontFamily: "'Crimson Pro', serif",
          fontSize: 17.5,
          color: 'var(--prose)',
          lineHeight: 1.75,
          margin: 0,
          letterSpacing: '-0.016em',
          fontWeight: 400,
        }}>
          Your funds are locked in an unbreakable vault on a non-custodial smart contract that no one, not even us, can touch.
          The key to that vault is a zero-knowledge proof forged entirely inside your browser, invisible to the outside world.
          While the proof is being crafted, keep this tab open. Close it and the magic stops, though your funds will always be waiting, safe and untouched, ready for you to try again.
        </p>
      </div>
    </div>
  );
}
