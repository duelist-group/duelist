// dapp/src/lib/relay.ts
// shared helpers for routing proofs through the relayer and polling confirmations.
// the relayer signs the outer stellar tx so the users wallet never appears on-chain.

import { rpc } from '@stellar/stellar-sdk';
import type { ProveTransferResult, ProveTransferBatchResult, ProveWithdrawResult } from '../hooks/WalletContext';

const toHex = (arr: number[]) => Buffer.from(new Uint8Array(arr)).toString('hex');

export async function relayTransfer(relayerUrl: string, result: ProveTransferResult): Promise<string> {
  const enc1 = result.encryptedNotes[0]!;
  const enc2 = result.encryptedNotes[1] ?? { ciphertext: new Array(108).fill(0), ephemeralPk: new Array(64).fill(0) };

  const resp = await fetch(`${relayerUrl}/relay/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof:             toHex(result.proofBytes),
      poolRoot:          result.publicData.poolRoot,
      nullifier1:        result.publicData.nullifier1,
      nullifier2:        result.publicData.nullifier2,
      outputCommitment1: result.publicData.outputCommitment1,
      outputCommitment2: result.publicData.outputCommitment2,
      assetId:           result.publicData.assetId,
      fee:               result.publicData.fee,
      txHash:            result.publicData.txHash,
      encryptedNote1:    toHex(enc1.ciphertext),
      encryptedNote2:    toHex(enc2.ciphertext),
      ephemeralPk1:      toHex(enc1.ephemeralPk),
      ephemeralPk2:      toHex(enc2.ephemeralPk),
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `Relay error ${resp.status}`);
  }
  const { hash, status } = await resp.json();
  if (status === 'ERROR') throw new Error('Relay: node rejected transaction');
  return hash as string;
}

export async function relayWithdraw(relayerUrl: string, result: ProveWithdrawResult, recipient: string): Promise<string> {
  const resp = await fetch(`${relayerUrl}/relay/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof:                toHex(result.proofBytes),
      poolRoot:             result.publicData.poolRoot,
      nullifiers:           result.publicData.nullifiers,
      changeCommitment:     result.publicData.changeCommitment,
      decoyCommitment:      result.publicData.decoyCommitment,
      assetId:              result.publicData.assetId,
      withdrawAmount:       result.publicData.withdrawAmount,
      fee:                  result.publicData.fee,
      recipient,
      recipientStellarHash: result.publicData.recipientStellarHash,
      txHash:               result.publicData.txHash,
      encryptedNoteChange:  toHex(result.encryptedNoteChange.ciphertext),
      encryptedNoteDecoy:   toHex(result.encryptedNoteDecoy.ciphertext),
      ephemeralPkChange:    toHex(result.encryptedNoteChange.ephemeralPk),
      ephemeralPkDecoy:     toHex(result.encryptedNoteDecoy.ephemeralPk),
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `Relay error ${resp.status}`);
  }
  const { hash, status } = await resp.json();
  if (status === 'ERROR') throw new Error('Relay: node rejected transaction');
  return hash as string;
}

export async function relayTransferBatch(relayerUrl: string, result: ProveTransferBatchResult): Promise<string> {
  const resp = await fetch(`${relayerUrl}/relay/transfer-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof:           toHex(result.proofBytes),
      poolRoot:        result.publicData.poolRoot,
      nullifiers:      result.publicData.nullifiers,
      outCommitments:  result.publicData.outCommitments,
      assetId:         result.publicData.assetId,
      fee:             result.publicData.fee,
      txHash:          result.publicData.txHash,
      encryptedNotes:  result.encryptedNotes.map(n => toHex(n.ciphertext)),
      ephemeralPks:    result.encryptedNotes.map(n => toHex(n.ephemeralPk)),
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `Relay error ${resp.status}`);
  }
  const { hash, status } = await resp.json();
  if (status === 'ERROR') throw new Error('Relay: node rejected transaction');
  return hash as string;
}

export async function pollTx(server: rpc.Server, hash: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await server.getTransaction(hash);
    if (res.status === 'SUCCESS') return;
    if (res.status === 'FAILED') throw new Error('Transaction failed on-chain');
  }
  throw new Error('Transaction timed out');
}

async function doUpdateRoot(relayerUrl: string, rpcUrl: string): Promise<void> {
  const resp = await fetch(`${relayerUrl}/relay/update-root`, { method: 'POST' });
  if (!resp.ok) return;
  const data = await resp.json().catch(() => ({}));
  if (data.hash) {
    const server = new rpc.Server(rpcUrl);
    await pollTx(server, data.hash, 15).catch(() => {});
  }
}

// pre-sync: align the on-chain root with the indexer before generating a proof.
// call at the start of any send/withdraw/payroll flow.
export async function preSyncPoolRoot(relayerUrl: string, rpcUrl: string): Promise<void> {
  try { await doUpdateRoot(relayerUrl, rpcUrl); } catch { }
}

// post-sync: wait for the indexer to process a new commitment, then sync the root.
// must be awaited between sequential payroll transfers to prevent poolrootmismatch.
export async function syncPoolRoot(relayerUrl: string, rpcUrl: string): Promise<void> {
  // wait longer than the indexers poll interval (5s) so it processes new events.
  await new Promise(r => setTimeout(r, 8000));
  try { await doUpdateRoot(relayerUrl, rpcUrl); } catch { }
}
