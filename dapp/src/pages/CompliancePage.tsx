// dapp/src/pages/compliancepage.tsx
import { useState } from 'react';
import { useWallet } from '../hooks/WalletContext';
import { card, cardClass, heading, subHeading, btnPrimary, btnSecondary, label } from '../components/Layout';
import { toast } from 'sonner';

type Tab = 'generate' | 'verify';

export function CompliancePage() {
  const w = useWallet();
  const [tab, setTab] = useState<Tab>('generate');

  const [commitmentHex, setCommitmentHex] = useState('');
  const [sourceAddress, setSourceAddress] = useState('');
  const [generatingPOI, setGeneratingPOI] = useState(false);
  const [poiResult, setPoiResult] = useState<string | null>(null);

  const [attestationJson, setAttestationJson] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; signerPkX?: string; signerPkY?: string } | null>(null);

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
    a.href = url; a.download = 'shield-poi.json'; a.click();
    URL.revokeObjectURL(url);
  };

  if (!w.shieldedAddress) {
    return (
      <div style={card} className={cardClass}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>Derive shielded keys first to use compliance tools.</p>
      </div>
    );
  }

  const tabStyle = (t: Tab): React.CSSProperties => ({
    flex: 1, padding: '8px 16px', borderRadius: 8, fontWeight: 400, fontSize: 13,
    border: 'none', cursor: 'pointer', fontFamily: "'Geist', sans-serif",
    background: tab === t ? 'var(--accent)' : 'transparent',
    color: tab === t ? '#fff' : 'var(--muted)',
  });

  return (
    <div>
      <div style={card} className={cardClass}>
        <h1 style={heading}>Compliance</h1>
        <p style={subHeading}>
          Generate a Proof of Innocence (POI) attestation signed by your spending key. Share it to prove your shielded funds are not from sanctioned sources. Verification runs entirely in your browser. Attestations are for <strong>deposit</strong> commitments only — they prove the public source of funds you brought into the pool; a Send or Withdraw note has no public source to attest.
        </p>

        <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: 'var(--surface2)', borderRadius: 10, padding: 4 }}>
          <button style={tabStyle('generate')} onClick={() => setTab('generate')}>Generate Attestation</button>
          <button style={tabStyle('verify')} onClick={() => setTab('verify')}>Verify Attestation</button>
        </div>

        {tab === 'generate' && (
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
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--muted)' }}>
              The public Stellar address that made the original deposit transaction for this note.
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
                  <div style={{ fontWeight: 400, color: 'var(--success)', fontSize: 13 }}>Attestation ready</div>
                  <button style={{ ...btnSecondary, padding: '5px 12px', fontSize: 12, borderRadius: 8 }} onClick={downloadPOI}>
                    Download .json
                  </button>
                </div>
                <textarea
                  readOnly
                  value={poiResult}
                  rows={12}
                  style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, color: 'var(--muted)', resize: 'vertical' }}
                />
                <p style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Share this file with an exchange or regulator to prove your funds are not from sanctioned sources.
                  The cryptographic signature binds this attestation to your shielded key — it cannot be forged.
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'verify' && (
          <div>
            <label style={label}>Attestation JSON</label>
            <textarea
              value={attestationJson}
              onChange={e => setAttestationJson(e.target.value)}
              placeholder='Paste a shield-poi.json here…'
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
                padding: 16, borderRadius: 10,
                background: verifyResult.valid ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${verifyResult.valid ? 'var(--accent-30)' : 'rgba(239,68,68,0.3)'}`,
              }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: verifyResult.valid ? 'var(--success)' : 'var(--danger)' }}>
                  {verifyResult.valid ? '✓ Valid attestation' : '✗ Invalid signature'}
                </div>
                {verifyResult.valid && verifyResult.signerPkX && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: "'Geist Mono', monospace", marginBottom: 8 }}>
                    Signer: {verifyResult.signerPkX.slice(0, 20)}…
                  </div>
                )}
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                  {verifyResult.valid
                    ? 'The Schnorr signature is cryptographically valid. Verify the claimed source address against OFAC and applicable sanctions lists independently.'
                    : 'The signature does not match the claimed public key. This attestation may be forged or corrupted.'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
