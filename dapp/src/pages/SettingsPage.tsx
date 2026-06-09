// dapp/src/pages/settingspage.tsx
import { useState } from 'react';
import { useWallet } from '../hooks/WalletContext';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label } from '../components/Layout';
import { useCurrency, SUPPORTED_CURRENCIES } from '../hooks/CurrencyContext';
import { useTheme } from '../hooks/useTheme';
import { toast } from 'sonner';

type ComplianceTab = 'generate' | 'verify';

export function SettingsPage() {
  const w = useWallet();
  const { currency, setCurrency } = useCurrency();
  const { theme, setTheme } = useTheme();

  // audit key state
  const [viewingKey, setViewingKey] = useState<string | null>(null);
  const [loadingVK, setLoadingVK] = useState(false);

  // compliance state
  const [complianceTab, setComplianceTab] = useState<ComplianceTab>('generate');
  const [commitmentHex, setCommitmentHex] = useState('');
  const [sourceAddress, setSourceAddress] = useState('');
  const [generatingPOI, setGeneratingPOI] = useState(false);
  const [poiResult, setPoiResult] = useState<string | null>(null);
  const [attestationJson, setAttestationJson] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; signerPkX?: string; signerPkY?: string } | null>(null);

  const handleRevealVK = async () => {
    setLoadingVK(true);
    try {
      const vk = await w.getViewingKey();
      setViewingKey(vk);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to retrieve viewing key');
    } finally {
      setLoadingVK(false);
    }
  };

  const handleCopyVK = async () => {
    if (!viewingKey) return;
    await navigator.clipboard.writeText(viewingKey);
    toast.success('Viewing key copied to clipboard');
  };

  const handleGenerate = async () => {
    if (!commitmentHex.startsWith('0x')) { toast.error('Commitment must start with 0x'); return; }
    if (!sourceAddress.startsWith('G') || sourceAddress.length !== 56) {
      toast.error('Source must be a valid G… Stellar address');
      return;
    }
    setGeneratingPOI(true);
    setPoiResult(null);
    try {
      const poi = await w.generatePOI(commitmentHex.trim(), sourceAddress.trim());
      setPoiResult(JSON.stringify(poi, null, 2));
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to generate attestation');
    } finally {
      setGeneratingPOI(false);
    }
  };

  const handleVerify = async () => {
    if (!attestationJson.trim()) { toast.error('Paste an attestation JSON first'); return; }
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await w.verifyPOI(attestationJson.trim());
      setVerifyResult(result);
    } catch (e: any) {
      toast.error(e.message ?? 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const downloadPOI = () => {
    if (!poiResult) return;
    const blob = new Blob([poiResult], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'duelist-poi.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const tabStyle = (t: ComplianceTab): React.CSSProperties => ({
    flex: 1,
    padding: '8px 14px',
    borderRadius: 7,
    fontWeight: 400,
    fontSize: 13,
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Geist', sans-serif",
    transition: 'background 0.15s, color 0.15s',
    background: complianceTab === t ? 'var(--green)' : 'transparent',
    color: complianceTab === t ? '#fff' : 'var(--muted)',
  });

  return (
    <div>
      {/* Appearance */}
      <div style={card} className={cardClass}>
        <h2 style={heading}>Appearance</h2>
        <p style={subHeading}>Choose your interface style.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 13.5, fontWeight: theme === 'light' ? 600 : 400, color: theme === 'light' ? 'var(--text)' : 'var(--muted)' }}>
            Light
          </span>
          <div
            role="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            style={{
              width: 52, height: 28, borderRadius: 14, flexShrink: 0,
              background: theme === 'dark' ? 'var(--green)' : 'var(--border2)',
              position: 'relative', cursor: 'pointer',
              transition: 'background 0.22s ease',
            }}
          >
            <span style={{
              position: 'absolute',
              top: 4,
              left: theme === 'dark' ? 28 : 4,
              width: 20, height: 20, borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
              transition: 'left 0.22s ease',
              display: 'block',
            }} />
          </div>
          <span style={{ fontSize: 13.5, fontWeight: theme === 'dark' ? 600 : 400, color: theme === 'dark' ? 'var(--text)' : 'var(--muted)' }}>
            Dark
          </span>
        </div>
      </div>

      {/* Display Currency */}
      <div style={card} className={cardClass}>
        <h2 style={heading}>Display Currency</h2>
        <p style={subHeading}>
          Choose the fiat currency for displaying your portfolio balance. Prices are fetched from CoinGecko.
        </p>
        <select
          value={currency.code}
          onChange={e => setCurrency(e.target.value)}
          style={{ width: '100%', maxWidth: 320 }}
        >
          {SUPPORTED_CURRENCIES.map(c => (
            <option key={c.code} value={c.code}>
              {c.symbol} {c.code.toUpperCase()} — {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Compliance */}
      {w.shieldedAddress && (
        <div style={card} className={cardClass}>
          <h2 style={heading}>Compliance</h2>
          <p style={subHeading}>
            Generate a Proof of Innocence (POI) attestation signed by your spending key. Share it to prove your shielded funds are not from sanctioned sources.
          </p>

          <div style={{
            display: 'flex',
            gap: 4,
            marginBottom: 22,
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 4,
          }}>
            <button style={tabStyle('generate')} onClick={() => setComplianceTab('generate')}>Generate</button>
            <button style={tabStyle('verify')} onClick={() => setComplianceTab('verify')}>Verify</button>
          </div>

          {complianceTab === 'generate' && (
            <div>
              <label style={label}>Note commitment (0x…)</label>
              <input
                value={commitmentHex}
                onChange={e => setCommitmentHex(e.target.value)}
                placeholder="0x1234…"
                disabled={generatingPOI}
                style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, marginBottom: 16 }}
              />

              <label style={label}>Depositing Stellar address</label>
              <input
                value={sourceAddress}
                onChange={e => setSourceAddress(e.target.value)}
                placeholder="G…"
                disabled={generatingPOI}
                style={{ marginBottom: 6 }}
              />
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                The public Stellar address that made the original deposit for this note.
              </p>

              <button
                style={{ ...btnPrimary, marginBottom: 20 }}
                onClick={handleGenerate}
                disabled={generatingPOI || !commitmentHex || !sourceAddress}
              >
                {generatingPOI ? 'Generating…' : 'Generate Attestation'}
              </button>

              {poiResult && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ fontWeight: 400, color: 'var(--green-dark)', fontSize: 13 }}>Attestation ready</div>
                    <button style={{ ...btnSecondary, padding: '5px 12px', fontSize: 12 }} onClick={downloadPOI}>
                      Download .json
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={poiResult}
                    rows={10}
                    style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--muted)', resize: 'vertical' }}
                  />
                  <p style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                    Share with an exchange or regulator to prove your funds are clean. The cryptographic signature binds this to your shielded key — it cannot be forged.
                  </p>
                </div>
              )}
            </div>
          )}

          {complianceTab === 'verify' && (
            <div>
              <label style={label}>Attestation JSON</label>
              <textarea
                value={attestationJson}
                onChange={e => setAttestationJson(e.target.value)}
                placeholder='Paste a duelist-poi.json here…'
                rows={10}
                disabled={verifying}
                style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, marginBottom: 16, resize: 'vertical' }}
              />

              <button
                style={{ ...btnPrimary, marginBottom: 16 }}
                onClick={handleVerify}
                disabled={verifying || !attestationJson.trim()}
              >
                {verifying ? 'Verifying…' : 'Verify Signature'}
              </button>

              {verifyResult && (
                <div style={{
                  padding: 16,
                  borderRadius: 10,
                  background: verifyResult.valid ? 'var(--accent-06)' : 'rgba(239,68,68,0.06)',
                  border: `1px solid ${verifyResult.valid ? 'var(--accent-30)' : 'rgba(239,68,68,0.3)'}`,
                }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: verifyResult.valid ? 'var(--green-dark)' : 'var(--red)' }}>
                    {verifyResult.valid ? '✓ Valid attestation' : '✗ Invalid signature'}
                  </div>
                  {verifyResult.valid && verifyResult.signerPkX && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", marginBottom: 8 }}>
                      Signer: {verifyResult.signerPkX.slice(0, 20)}…
                    </div>
                  )}
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                    {verifyResult.valid
                      ? 'The Schnorr signature is cryptographically valid. Verify the claimed source address against applicable sanctions lists independently.'
                      : 'The signature does not match the claimed public key. This attestation may be forged or corrupted.'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Audit Key */}
      {w.shieldedAddress && (
        <div style={card} className={cardClass}>
          <h2 style={heading}>Audit Key</h2>
          <p style={subHeading}>
            Share your viewing key with auditors to prove your transaction history. It cannot be used to spend funds.
          </p>

          {!viewingKey ? (
            <button
              style={btnSecondary}
              onClick={handleRevealVK}
              disabled={loadingVK}
            >
              {loadingVK ? 'Loading…' : 'Reveal Viewing Key'}
            </button>
          ) : (
            <div>
              <label style={label}>Viewing key</label>
              <div style={{
                background: 'var(--surface2)',
                padding: '12px 14px',
                borderRadius: 8,
                fontFamily: "'Geist Mono', monospace",
                fontSize: 11,
                wordBreak: 'break-all',
                border: '1px solid var(--border)',
                marginBottom: 10,
                color: 'var(--muted)',
                lineHeight: 1.7,
              }}>
                {viewingKey}
              </div>
              <button style={{ ...btnSecondary, marginBottom: 12 }} onClick={handleCopyVK}>
                Copy to Clipboard
              </button>
              <div style={{
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 12,
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.3)',
                color: 'var(--orange)',
                lineHeight: 1.6,
              }}>
                Anyone with this key can see all your shielded balances and transaction history. Do not share publicly.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
