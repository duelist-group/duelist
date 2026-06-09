// dapp/src/pages/payrollpage.tsx
import { useState, useEffect } from 'react';
import { rpc } from '@stellar/stellar-sdk';
import { useWallet } from '../hooks/WalletContext';
import { NETWORK } from '../lib/config';
import { relayTransferBatch, pollTx, syncPoolRoot, preSyncPoolRoot } from '../lib/relay';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label, availableBar, feeTable, feeRow } from '../components/Layout';
import { useTokens } from '../hooks/TokenContext';
import { useViewport } from '../hooks/useViewport';
import { toast } from 'sonner';
import { PayrollProgressModal, PayrollStatus } from '../components/PayrollProgressModal';

import payrollIcon from '../assets/icons/payroll.svg';
import xIcon from '../assets/icons/x.svg';

const RELAY_FEE_STROOPS = 10_000_000n; // 1.0 units (7-decimal tokens) — must match relayer MIN_RELAY_FEE + on-chain relay_fee_min

interface Recipient {
  id: string;
  address: string;
  amount: string;
}

// Persist the recipient draft so a mobile reload (iOS evicting the tab mid-flow)
// never loses the list you typed.
const DRAFT_KEY = 'shield-payroll-draft';
function loadDraft(): Recipient[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]');
    if (Array.isArray(raw) && raw.length) {
      return raw.map((r: any) => ({ id: crypto.randomUUID(), address: String(r.address ?? ''), amount: String(r.amount ?? '') }));
    }
  } catch { /* ignore */ }
  return [{ id: crypto.randomUUID(), address: '', amount: '' }];
}

export function PayrollPage() {
  const w = useWallet();
  const vp = useViewport();
  if (w.isInitializing) return null;
  const { tokens } = useTokens();
  const [selectedTokenId, setSelectedTokenId] = useState(tokens[0].assetId);
  const [recipients, setRecipients] = useState<Recipient[]>(loadDraft);
  const [running, setRunning] = useState(false);
  const [statuses, setStatuses] = useState<PayrollStatus[]>([]);
  const [showModal, setShowModal] = useState(false);

  // keep the draft in sync so a reload restores the list (cleared on success).
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(recipients.map(r => ({ address: r.address, amount: r.amount }))));
    } catch { /* ignore */ }
  }, [recipients]);

  const selectedToken = tokens.find(t => t.assetId === selectedTokenId) || tokens[0];
  const balance = w.balances.get(selectedTokenId) ?? 0n;
  const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const balanceDisplay = fmt2(Number(balance) / Math.pow(10, selectedToken.decimals));
  const splitNum = (s: string) => { const i = s.lastIndexOf('.'); return i === -1 ? { int: s, dec: '' } : { int: s.slice(0, i), dec: s.slice(i) }; };

  const validRecipients = recipients.filter(r => r.address.startsWith('zk1') && parseFloat(r.amount || '0') > 0);
  const totalAmount = validRecipients.reduce((sum, r) => {
    const parsed = parseFloat(r.amount);
    const stroops = isNaN(parsed) ? 0n : BigInt(Math.floor(parsed * Math.pow(10, selectedToken.decimals)));
    return sum + stroops;
  }, 0n);
  // batch pays everyone in one transaction -> a single relay fee, not n x.
  const totalWithFees = totalAmount + RELAY_FEE_STROOPS;
  // only flag "insufficient" once the user has actually entered an amount —
  // otherwise the lone relay fee makes an empty form look over-budget on load.
  const overBalance = totalAmount > 0n && totalWithFees > balance;
  const totalDisplay = fmt2(Number(totalAmount) / Math.pow(10, selectedToken.decimals));
  const feeDisplay = fmt2(Number(RELAY_FEE_STROOPS) / Math.pow(10, selectedToken.decimals));
  const MAX_RECIPIENTS = 10;

  const addRecipient = () => setRecipients(prev => [...prev, { id: crypto.randomUUID(), address: '', amount: '' }]);
  const removeRecipient = (id: string) => setRecipients(prev => prev.filter(r => r.id !== id));
  const updateRecipient = (id: string, field: 'address' | 'amount', value: string) =>
    setRecipients(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const lines = text.split('\n').map(l => l.trim().replace(/\r$/, '')).filter(l => l && !l.startsWith('#'));
      const parsed = lines.flatMap((line, idx) => {
        const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        const [address, amount] = parts;
        if (!address) return [];
        if (idx === 0 && (isNaN(parseFloat(amount ?? '')) || (amount ?? '').toLowerCase() === 'amount')) return [];
        return [{ id: crypto.randomUUID(), address, amount: amount ?? '' }];
      });
      if (parsed.length === 0) { toast.error('No valid rows found in CSV'); return; }
      setRecipients(parsed);
      toast.success(`Imported ${parsed.length} recipient${parsed.length !== 1 ? 's' : ''}`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const setStatus = (id: string, patch: Partial<PayrollStatus>) =>
    setStatuses(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));

  const handleExecute = async () => {
    if (!w.shieldedAddress || !w.stellarAddress) {
      toast.error('Wallet not ready.'); return;
    }
    const valid = recipients.filter(r => r.address.startsWith('zk1') && parseFloat(r.amount) > 0);
    if (valid.length === 0) {
      toast.error('Add at least one valid recipient with a zk1 address and amount'); return;
    }
    if (valid.length > MAX_RECIPIENTS) {
      toast.error(`Max ${MAX_RECIPIENTS} recipients per batch. Split into multiple campaigns.`); return;
    }
    if (totalWithFees > balance) {
      toast.error('Insufficient shielded balance for all transfers + fees'); return;
    }

    setRunning(true);
    setShowModal(true);
    const shortAddr = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
    const initialStatuses: PayrollStatus[] = valid.map(r => ({
      id: r.id,
      shortAddr: shortAddr(r.address),
      state: 'pending',
    }));
    setStatuses(initialStatuses);

    const server = new rpc.Server(NETWORK.rpcUrl);

    try {
      await preSyncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl);

      const recipientsArg = valid.map(r => ({
        address: r.address,
        amount: BigInt(Math.floor(parseFloat(r.amount) * Math.pow(10, selectedToken.decimals))).toString(),
      }));

      // all recipients are paid in a single batch transaction — statuses move in lockstep.
      setStatuses(prev => prev.map(s => ({ ...s, state: 'proving' })));
      const result = await w.proveTransferBatch(recipientsArg, selectedTokenId, RELAY_FEE_STROOPS.toString());

      setStatuses(prev => prev.map(s => ({ ...s, state: 'submitting' })));
      const hash = await relayTransferBatch(NETWORK.relayerUrls[0], result);
      await pollTx(server, hash, 30);

      setStatuses(prev => prev.map(s => ({ ...s, state: 'success' })));

      const batchItems = valid.map((r, i) => ({
        address: r.address, amount: r.amount, state: 'success' as const,
        txHash: hash, commitment: result.publicData.outCommitments[i], shortAddr: shortAddr(r.address),
      }));
      try {
        const batch = { id: crypto.randomUUID(), timestamp: Date.now(), tokenId: selectedTokenId, symbol: selectedToken.symbol, transfers: batchItems };
        const existing: object[] = JSON.parse(localStorage.getItem('shield-payroll-history') || '[]');
        localStorage.setItem('shield-payroll-history', JSON.stringify([batch, ...existing].slice(0, 50)));
      } catch { /* noop */ }

      await w.refresh();
      syncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl).catch(() => {});
      toast.success(`Paid ${valid.length} recipient${valid.length !== 1 ? 's' : ''} in one transaction!`);
      setRecipients([{ id: crypto.randomUUID(), address: '', amount: '' }]);
    } catch (e: any) {
      let errMsg: string = e?.message ?? String(e);
      if (errMsg.length > 100) errMsg = errMsg.slice(0, 100) + '…';
      setStatuses(prev => prev.map(s => ({ ...s, state: 'failed', error: errMsg })));
      toast.error(`Payroll failed: ${errMsg}`);
      await syncPoolRoot(NETWORK.relayerUrls[0], NETWORK.rpcUrl).catch(() => {});
    } finally {
      setRunning(false);
    }
  };

  const canExecute = !running && !!w.shieldedAddress && !!w.stellarAddress &&
    recipients.some(r => r.address.startsWith('zk1') && parseFloat(r.amount) > 0);

  return (
    <div>
      {showModal && statuses.length > 0 && (
        <PayrollProgressModal
          statuses={statuses}
          total={statuses.length}
          onDismiss={() => { setShowModal(false); setStatuses([]); }}
        />
      )}
      <div style={card} className={cardClass}>
        <h1 style={heading}>Payroll</h1>
        <p style={subHeading}>
          Dispatch shielded payments to an entire company of recipients in one campaign. Each warrior receives a ZK-encrypted note — unlinkable on-chain, untraceable in battle.
        </p>

        {/* Available bar */}
        <div style={availableBar}>
          <span>Available:</span>
          <strong style={{ color: 'var(--text)', marginLeft: 4, opacity: w.isRefreshing ? 0.5 : 1, transition: 'opacity 0.3s' }}>
            {splitNum(balanceDisplay).int}<span style={{ color: 'var(--muted2)' }}>{splitNum(balanceDisplay).dec}</span> {selectedToken.symbol}
          </strong>
        </div>

        <label style={label}>Asset</label>
        <select
          value={selectedTokenId}
          onChange={e => setSelectedTokenId(e.target.value)}
          disabled={running}
          style={{ width: '100%', marginBottom: 20 }}
        >
          {tokens.map(t => <option key={t.assetId} value={t.assetId}>{t.symbol} — {t.name}</option>)}
        </select>

        {/* Recipients header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--muted2)', letterSpacing: '0.01em' }}>
            Recipients
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={addRecipient}
              disabled={running || recipients.length >= MAX_RECIPIENTS}
              style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12 }}
            >
              + Add
            </button>
            <label style={{
              ...btnSecondary,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}>
              Import CSV
              <input type="file" accept=".csv,text/csv" onChange={handleImportCSV} disabled={running} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        {/* Column headers — hidden on mobile where rows stack into labelled blocks */}
        {!vp.isMobile && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1, fontSize: 11, fontWeight: 400, color: 'var(--muted2)', letterSpacing: '0.01em' }}>
              Shielded address
            </div>
            <div style={{ width: 130, flexShrink: 0, fontSize: 11, fontWeight: 400, color: 'var(--muted2)', letterSpacing: '0.01em', textAlign: 'right' }}>
              Amount
            </div>
            <div style={{ width: 40, flexShrink: 0 }} />
          </div>
        )}

        {/* Recipient rows — inline on desktop/tablet, stacked card per row on mobile */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: vp.isMobile ? 12 : 8, marginBottom: 20 }}>
          {recipients.map((r) => (
            <div
              key={r.id}
              style={vp.isMobile
                ? { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }
                : { display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <input
                value={r.address}
                onChange={e => updateRecipient(r.id, 'address', e.target.value)}
                placeholder="zk1…"
                disabled={running}
                style={{
                  flex: 1,
                  width: vp.isMobile ? '100%' : undefined,
                  fontFamily: "'Geist Mono', monospace",
                  fontSize: 12,
                  marginBottom: 0,
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={r.amount}
                  onChange={e => updateRecipient(r.id, 'amount', e.target.value)}
                  placeholder="0.00"
                  disabled={running}
                  step="0.001"
                  min="0"
                  style={{
                    width: vp.isMobile ? undefined : 130,
                    flex: vp.isMobile ? 1 : undefined,
                    flexShrink: 0,
                    textAlign: 'right',
                    marginBottom: 0,
                  }}
                />
                <button
                  onClick={() => removeRecipient(r.id)}
                  disabled={running || recipients.length === 1}
                  className="logout-btn"
                  style={{
                    opacity: recipients.length === 1 || running ? 0.3 : 1,
                    flexShrink: 0,
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <img src={xIcon} width={14} height={14} style={{ opacity: 0.55 }} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Fee table */}
        <div style={{ ...feeTable, marginBottom: 20 }}>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Subtotal</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {totalDisplay} {selectedToken.symbol}
            </span>
          </div>
          <div style={feeRow}>
            <span style={{ color: 'var(--muted)' }}>Relay fee (1 batch tx)</span>
            <span style={{ color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", fontSize: 12 }}>
              {feeDisplay} {selectedToken.symbol}
            </span>
          </div>
          <div style={{ ...feeRow, fontWeight: 400 }}>
            <span>Total deducted</span>
            <span style={{
              color: overBalance ? 'var(--red)' : 'var(--text)',
              fontFamily: "'Geist Mono', monospace",
              fontSize: 12,
            }}>
              {fmt2(Number(totalWithFees) / Math.pow(10, selectedToken.decimals))} {selectedToken.symbol}
            </span>
          </div>
          <div style={{ ...feeRow, borderBottom: 'none' }}>
            <span style={{ color: 'var(--muted)' }}>Balance remaining</span>
            <span style={{
              color: overBalance ? 'var(--red)' : 'var(--muted)',
              fontFamily: "'Geist Mono', monospace",
              fontSize: 12,
            }}>
              {totalWithFees <= balance
                ? fmt2(Number(balance - totalWithFees) / Math.pow(10, selectedToken.decimals))
                : '—'
              } {selectedToken.symbol}
            </span>
          </div>
        </div>


        <button
          style={{
            ...btnPrimary,
            width: '100%',
            padding: '13px 20px',
            fontSize: 15,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
          onClick={handleExecute}
          disabled={!canExecute || overBalance}
        >
          <img src={payrollIcon} width={16} height={16} style={{ filter: 'brightness(0) invert(1)', flexShrink: 0 }} />
          {running ? 'Executing payroll…' : 'Execute Payroll'}
        </button>

        {overBalance && (
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--red)', textAlign: 'center' }}>
            Insufficient balance. Reduce amounts or remove recipients.
          </p>
        )}

        <p style={{ marginTop: 14, fontSize: 12, color: 'var(--muted2)', lineHeight: 1.65, textAlign: 'center',  }}>
          Up to {MAX_RECIPIENTS} recipients are paid in a single shielded transaction, padded with decoy outputs — the recipients remain unlinkable even to each other.
        </p>
      </div>
    </div>
  );
}
