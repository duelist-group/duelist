// dapp/src/pages/historypage.tsx
import { useEffect, useState } from 'react';
import { useWallet } from '../hooks/WalletContext';
import { useTokens } from '../hooks/TokenContext';
import { useCurrency } from '../hooks/CurrencyContext';
import { useDarkMode } from '../hooks/useDarkMode';
import { card, cardClass, heading, btnPrimary, btnSecondary } from '../components/Layout';
import { NETWORK } from '../lib/config';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';

import piggyIcon from '../assets/icons/piggy-bank.svg';
import sendIcon from '../assets/icons/send.svg';
import receiveIcon from '../assets/icons/receive.svg';
import withdrawIcon from '../assets/icons/withdraw.svg';
import payrollIcon from '../assets/icons/payroll.svg';
import { useViewport } from '../hooks/useViewport';
import chevronDownIcon from '../assets/icons/chevron-down.svg';
import chevronUpIcon from '../assets/icons/chevron-up.svg';

interface IndexerEvent {
  type: 'deposit' | 'transfer' | 'withdraw' | 'xfr_batch';
  ledger: number;
  txHash?: string;
  commitment?: number[];
  leafIndex?: number;
  commitment1?: number[];
  commitment2?: number[] | null;
  leafIndex1?: number;
  leafIndex2?: number | null;
  nullifiers?: number[][];
  nullifier?: number[];
  outputs?: { commitment: number[]; leafIndex: number; encryptedNote: number[]; ephemeralPk: number[] }[];
}

interface PayrollBatchTransfer {
  address: string;
  amount: string;
  state: 'success' | 'failed';
  txHash?: string;
  commitment?: string;
  shortAddr: string;
  error?: string;
}

interface PayrollBatch {
  id: string;
  timestamp: number;
  tokenId: string;
  symbol: string;
  transfers: PayrollBatchTransfer[];
}

const PAGE_SIZE = 10;
// relay fee, in stroops — must match RELAY_FEE in Send/Withdraw/Payroll and the
// relayer MIN_RELAY_FEE. used here to reconstruct displayed sent/withdrawn amounts
// (input total minus change minus this fee).
const RELAY_FEE_STROOPS = 10_000_000n;

function EventIcon({ type }: { type: string }) {
  const iconMap: Record<string, { src: string; bg: string; filter: string }> = {
    deposit:  { src: piggyIcon,    bg: 'var(--green-bg)',   filter: 'invert(40%) sepia(100%) saturate(400%) hue-rotate(90deg)' },
    received: { src: receiveIcon,  bg: 'var(--green-bg)',   filter: 'invert(40%) sepia(100%) saturate(400%) hue-rotate(90deg)' },
    sent:     { src: sendIcon,     bg: 'rgba(239,68,68,0.08)',  filter: 'invert(27%) sepia(96%) saturate(4500%) hue-rotate(340deg)' },
    withdraw: { src: withdrawIcon, bg: 'rgba(245,158,11,0.1)',  filter: 'invert(60%) sepia(90%) saturate(500%) hue-rotate(2deg)' },
    payroll:  { src: payrollIcon,  bg: 'rgba(99,102,241,0.1)',  filter: 'invert(35%) sepia(60%) saturate(800%) hue-rotate(210deg)' },
  };
  const cfg = iconMap[type] ?? iconMap.deposit;
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: cfg.bg,
    }}>
      <img src={cfg.src} width={16} height={16} style={{ filter: `brightness(0) saturate(100%) ${cfg.filter}` }} />
    </div>
  );
}

export function HistoryPage() {
  const w = useWallet();
  if (w.isInitializing) return null;
  const { tokens } = useTokens();
  const nav = useNavigate();
  const { xlmPrice, usdcPrice, eurcPrice, currency, priceLoaded } = useCurrency();
  const { dark } = useDarkMode();
  const [events, setEvents] = useState<IndexerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const vp = useViewport();

  useEffect(() => {
    if (!w.shieldedAddress) { setLoading(false); return; }
    const url = NETWORK.indexerUrls[0];
    if (!url) { setLoading(false); return; }
    fetch(`${url}/events?since=0`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((data: any) => {
        setEvents(Array.isArray(data?.events) ? data.events : []);
        setLoading(false);
      })
      .catch(e => {
        setFetchError(String(e));
        setLoading(false);
      });
  }, [w.shieldedAddress]);

  const payrollBatches: PayrollBatch[] = (() => {
    try { return JSON.parse(localStorage.getItem('shield-payroll-history') || '[]'); } catch { return []; }
  })();

  const txToBatch = new Map<string, PayrollBatch>();
  for (const b of payrollBatches) {
    for (const t of b.transfers) {
      if (t.txHash) txToBatch.set(t.txHash, b);
    }
  }

  const toHex = (arr?: number[] | null): string | null => {
    if (!arr) return null;
    return '0x' + arr.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const getNote = (arr?: number[] | null) => {
    const h = toHex(arr);
    if (!h) return null;
    return w.ownedCommitments.get(h) ?? null;
  };

  const fiatStr = (amt: number, sym: string): string | null => {
    if (!priceLoaded || amt <= 0) return null;
    const rate = sym === 'XLM' ? xlmPrice : sym === 'USDC' ? usdcPrice : sym === 'EURC' ? eurcPrice : 0;
    if (rate <= 0) return null;
    const decimals = currency.noDecimals ? 0 : 2;
    return `≈ ${currency.symbol}${(amt * rate).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  };

  const formatAmount = (note: { amount: string; assetId: string } | null): { display: string; fiat: string | null } | null => {
    if (!note) return null;
    const token = tokens.find(t => t.assetId === note.assetId || t.assetId === note.assetId.replace(/^0x/, ''));
    const amt = Number(BigInt(note.amount)) / Math.pow(10, token?.decimals ?? 7);
    const sym = token?.symbol ?? '';
    return {
      display: `${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`,
      fiat: fiatStr(amt, sym),
    };
  };

  type ProcessedEvent = {
    key: string;
    displayType: string;
    amountDisplay: string | null;
    fiatDisplay: string | null;
    commitmentHex: string | null;
    ledger: number;
    txHash?: string;
    sign: '+' | '-';
    signColor: string;
    payrollBatch?: PayrollBatch;
  };

  const allEvents: ProcessedEvent[] = [];
  const seenBatchIds = new Set<string>();
  const reversed = [...events].reverse();

  reversed.forEach((ev, i) => {
    // check if this transfer/batch belongs to a payroll batch (sender side)
    if ((ev.type === 'transfer' || ev.type === 'xfr_batch') && ev.txHash && txToBatch.has(ev.txHash)) {
      const batch = txToBatch.get(ev.txHash)!;
      if (seenBatchIds.has(batch.id)) return;
      seenBatchIds.add(batch.id);

      const successCount = batch.transfers.filter(t => t.state === 'success').length;
      const totalAmt = batch.transfers
        .filter(t => t.state === 'success')
        .reduce((s, t) => s + parseFloat(t.amount || '0'), 0);
      const amtDisplay = `${totalAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${batch.symbol}`;
      const fiatD = fiatStr(totalAmt, batch.symbol);

      allEvents.push({
        key: `payroll-${batch.id}`,
        displayType: 'payroll',
        amountDisplay: amtDisplay,
        fiatDisplay: fiatD,
        commitmentHex: null,
        ledger: ev.ledger,
        txHash: ev.txHash,
        sign: '-',
        signColor: 'var(--red)',
        payrollBatch: batch,
      });
      return;
    }

    let displayType: string;
    let amountResult: { display: string; fiat: string | null } | null = null;
    let sign: '+' | '-' = '+';

    if (ev.type === 'deposit') {
      const note = getNote(ev.commitment);
      displayType = 'deposit';
      sign = '+';
      amountResult = formatAmount(note);
      if (!amountResult) return;
    } else if (ev.type === 'transfer') {
      const note1 = getNote(ev.commitment1);
      const note2 = getNote(ev.commitment2);
      if (note2) {
        // both outputs owned = self-transfer (withdrawal split step) — hide it
        if (note1) return;
        displayType = 'sent';
        sign = '-';
        let totalInputAmt = 0n;
        for (const nfArr of ev.nullifiers ?? []) {
          const nfHex = '0x' + nfArr.map(b => b.toString(16).padStart(2, '0')).join('');
          const entry = w.nullifierAmounts.get(nfHex);
          if (entry) totalInputAmt += entry.amount;
        }
        if (totalInputAmt > 0n) {
          const sentAmt = totalInputAmt - BigInt(note2.amount) - RELAY_FEE_STROOPS;
          if (sentAmt > 0n) {
            amountResult = formatAmount({ amount: sentAmt.toString(), assetId: note2.assetId });
          }
        }
      } else if (note1) {
        displayType = 'received';
        sign = '+';
        amountResult = formatAmount(note1);
      } else {
        return;
      }
    } else if (ev.type === 'xfr_batch') {
      // recipient side: find the batch output note owned by this wallet.
      // (the senders batch is matched to their saved payroll above and returns early,
      // so reaching here means we received one of the outputs.)
      let received: { amount: string; assetId: string } | null = null;
      for (const o of ev.outputs ?? []) {
        const note = getNote(o.commitment);
        if (note) { received = note; break; }
      }
      if (!received) return;
      displayType = 'received';
      sign = '+';
      amountResult = formatAmount(received);
      if (!amountResult) return;
    } else {
      displayType = 'withdraw';
      sign = '-';
      // multi-input withdraw: sum all spent input notes, then subtract the change
      // note that came back to us. (the old single-note logic only read nullifiers[0],
      // so a multi-note withdraw under-reported as a single note.)
      let totalIn = 0n;
      let assetId = '';
      const nfList = ev.nullifiers && ev.nullifiers.length > 0
        ? ev.nullifiers
        : (ev.nullifier ? [ev.nullifier] : []);
      for (const nfArr of nfList) {
        const nfHex = '0x' + nfArr.map(b => b.toString(16).padStart(2, '0')).join('');
        const entry = w.nullifierAmounts.get(nfHex);
        if (entry) { totalIn += entry.amount; if (!assetId) assetId = entry.assetId; }
      }
      // change + decoy outputs return to us — dont count them as withdrawn.
      let returned = 0n;
      for (const o of ev.outputs ?? []) {
        const note = getNote(o.commitment);
        if (note) returned += BigInt(note.amount);
      }
      if (totalIn > returned + RELAY_FEE_STROOPS) {
        // net to recipient = (totalin - change - relay) * 10000 / 10025 (reverse 0.25% protocol fee)
        const netStroops = (totalIn - returned - RELAY_FEE_STROOPS) * 10000n / 10025n;
        if (netStroops > 0n) {
          amountResult = formatAmount({ amount: netStroops.toString(), assetId });
        }
      }
      if (!amountResult) return;
    }

    const signColor = sign === '+' ? 'var(--green-dark)' : 'var(--red)';

    let commitmentHex: string | null = null;
    if (ev.type === 'deposit') commitmentHex = toHex(ev.commitment);
    else if (ev.type === 'transfer') commitmentHex = toHex(ev.commitment1);
    else if (ev.type === 'xfr_batch') {
      for (const o of ev.outputs ?? []) {
        const hh = toHex(o.commitment);
        if (hh && w.ownedCommitments.get(hh)) { commitmentHex = hh; break; }
      }
    }
    else commitmentHex = toHex(ev.nullifier ?? ev.nullifiers?.[0]);

    allEvents.push({
      key: String(i),
      displayType,
      amountDisplay: amountResult?.display ?? null,
      fiatDisplay: amountResult?.fiat ?? null,
      commitmentHex,
      ledger: ev.ledger,
      txHash: ev.txHash,
      sign,
      signColor,
    });
  });

  const totalPages = Math.max(1, Math.ceil(allEvents.length / PAGE_SIZE));
  const pageEvents = allEvents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const getExplorerLink = (ev: ProcessedEvent) => {
    if (ev.txHash) return `${NETWORK.explorerBase}/tx/${ev.txHash}`;
    return `${NETWORK.explorerBase}/ledger/${ev.ledger}`;
  };

  const getLinkLabel = (ev: ProcessedEvent) => {
    if (ev.txHash) return `${ev.txHash.slice(0, 8)}…${ev.txHash.slice(-6)} ↗`;
    return `Ledger ${ev.ledger} ↗`;
  };

  const toggleBatch = (id: string) => setExpandedBatches(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div>
      <div style={card} className={cardClass}>
        <h1 style={heading}>History</h1>

        {!w.shieldedAddress ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ color: 'var(--muted)', marginBottom: 16 }}>Derive shielded keys first.</div>
            <button style={btnPrimary} onClick={() => nav('/setup')}>Get Started</button>
          </div>
        ) : loading || (w.isRefreshing && w.ownedCommitments.size === 0) ? (
          <div>
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton" style={{ height: 60, borderRadius: 8, marginBottom: 10 }} />
            ))}
          </div>
        ) : fetchError ? (
          <div style={{ padding: 16, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13 }}>
            Could not load events from indexer: {fetchError}
          </div>
        ) : allEvents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--muted)' }}>
            <img src={piggyIcon} width={32} height={32} style={{ opacity: 0.45, marginBottom: 12, display: 'block', margin: '0 auto 12px', filter: dark ? 'invert(1)' : undefined }} />
            <div style={{ fontWeight: 400, marginBottom: 6 }}>No events yet</div>
            <div style={{ fontSize: 13, marginBottom: 20 }}>Deposit funds to get started.</div>
            <button style={btnPrimary} onClick={() => nav('/deposit')}>Deposit Now</button>
          </div>
        ) : (
          <>
            <div>
              {pageEvents.map(ev => {
                const isPayroll = ev.displayType === 'payroll';
                const batchId = ev.payrollBatch?.id ?? '';
                const isExpanded = expandedBatches.has(batchId);

                return (
                  <div key={ev.key} style={{ borderBottom: '1px solid var(--border)' }}>
                    {/* Main row */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        padding: '13px 0',
                        cursor: isPayroll ? 'pointer' : 'default',
                      }}
                      onClick={isPayroll ? () => toggleBatch(batchId) : undefined}
                    >
                      <EventIcon type={ev.displayType} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 400, fontSize: 14, textTransform: 'capitalize', color: 'var(--text)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {ev.displayType}
                          {isPayroll && (
                            <img src={isExpanded ? chevronUpIcon : chevronDownIcon} width={14} height={14} style={{ opacity: 0.5, filter: dark ? 'invert(1)' : undefined }} />
                          )}
                        </div>
                        {isPayroll && vp.isMobile && ev.payrollBatch && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                            {ev.payrollBatch.transfers.length} recipient{ev.payrollBatch.transfers.length !== 1 ? 's' : ''} · one transaction
                          </div>
                        )}
                        {!isPayroll && ev.commitmentHex && (
                          <div>
                            <span
                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(ev.commitmentHex!); toast.success('Commitment copied'); }}
                              title={ev.commitmentHex}
                              style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
                            >
                              {ev.commitmentHex.slice(0, 10)}…{ev.commitmentHex.slice(-6)}
                            </span>
                          </div>
                        )}
                        {!isPayroll && (
                          <div>
                            <a
                              href={getExplorerLink(ev)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="tx-link"
                              style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--blue-link)', textDecoration: 'none' }}
                            >
                              {getLinkLabel(ev)}
                            </a>
                          </div>
                        )}
                        {isPayroll && ev.txHash && (
                          <div>
                            <a
                              href={`${NETWORK.explorerBase}/tx/${ev.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="tx-link"
                              style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--blue-link)', textDecoration: 'none' }}
                            >
                              {ev.txHash.slice(0, 8)}…{ev.txHash.slice(-6)} ↗
                            </a>
                          </div>
                        )}
                      </div>

                      {ev.amountDisplay && (
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontWeight: 400, fontSize: 14, color: ev.signColor }}>
                            {ev.sign}{ev.amountDisplay}{isPayroll && !vp.isMobile && ev.payrollBatch ? ` · ${ev.payrollBatch.transfers.length} recipient${ev.payrollBatch.transfers.length !== 1 ? 's' : ''}` : ''}
                          </div>
                          {ev.fiatDisplay && (
                            <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 1 }}>{ev.fiatDisplay}</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Payroll children (expanded) */}
                    {isPayroll && isExpanded && ev.payrollBatch && (
                      <div style={{ marginBottom: 12, marginLeft: 50, borderLeft: '2px solid var(--border)', paddingLeft: 14 }}>
                        {ev.payrollBatch.transfers.map((t, ti) => (
                          <div key={ti} style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '8px 0',
                            borderBottom: ti < ev.payrollBatch!.transfers.length - 1 ? '1px solid var(--border)' : 'none',
                          }}>
                            <div style={{
                              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                              background: t.state === 'success' ? 'var(--green)' : 'var(--red)',
                            }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--text)', marginBottom: 2 }}>
                                {t.shortAddr}
                              </div>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                {t.commitment && (
                                  <span
                                    onClick={() => { navigator.clipboard.writeText(t.commitment!); toast.success('Commitment copied'); }}
                                    style={{ fontFamily: "'Geist Mono', monospace", fontSize: 10, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
                                    title={t.commitment}
                                  >
                                    {t.commitment.slice(0, 10)}…{t.commitment.slice(-6)}
                                  </span>
                                )}
                                {t.state === 'failed' && t.error && (
                                  <span style={{
                                    fontSize: 10,
                                    color: 'var(--red)',
                                    background: 'rgba(239,68,68,0.08)',
                                    border: '1px solid rgba(239,68,68,0.2)',
                                    borderRadius: 4,
                                    padding: '1px 6px',
                                    fontFamily: "'Geist Mono', monospace",
                                  }} title={t.error}>
                                    {t.error.length > 48 ? t.error.slice(0, 48) + '…' : t.error}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 13, fontWeight: 400, color: t.state === 'success' ? 'var(--red)' : 'var(--muted2)' }}>
                              {t.state === 'success' ? `-${parseFloat(t.amount || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ev.payrollBatch!.symbol}` : 'Failed'}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingTop: 18 }}>
                <button
                  style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  ← Prev
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    style={{
                      padding: '6px 10px', borderRadius: 6, fontSize: 12,
                      fontWeight: page === p ? 700 : 400,
                      border: page === p ? '1.5px solid var(--green)' : '1px solid var(--border)',
                      background: page === p ? 'var(--green-bg)' : 'transparent',
                      color: page === p ? 'var(--green-dark)' : 'var(--muted)',
                      cursor: 'pointer', fontFamily: "'Geist', sans-serif",
                    }}
                  >
                    {p}
                  </button>
                ))}

                <button
                  style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12 }}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
