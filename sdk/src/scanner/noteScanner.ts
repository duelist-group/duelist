// sdk/src/scanner/notescanner.ts
// scan soroban contract events for notes addressed to this wallet.

import { tryDecryptNote } from '../crypto/noteEncryption.js';
import { deriveNullifierExact } from '../crypto/keys.js';
import { poseidon2 } from '../crypto/poseidon.js';
import { bytes32ToField } from '../utils/encoding.js';
import type { ShieldedKeypair, DiscoveredNote, Field } from '../utils/types.js';

export interface ScanResult {
  newNotes: DiscoveredNote[];
  spentNullifiers: Field[];
  highestLedger: number;
}

export interface RawEvent {
  ledger: number;
  topic: string;          // 'deposit' | 'transfer' | 'withdraw'
  encryptedNote: Uint8Array;
  ephemeralPk: Uint8Array;
  commitment: Uint8Array; // 32 bytes
  leafIndex: number;
  /** For transfer events: the nullifiers that were spent. */
  nullifiers?: Uint8Array[];
}

/**
 * Compute the note commitment as Noir's circuit does.
 * commitment = Poseidon2(owner_pk_x, owner_pk_y, asset_id, amount, blinding)
 */
async function computeCommitment(
  ownerPkX: Field, ownerPkY: Field, assetId: Field, amount: bigint, blinding: Field,
): Promise<Field> {
  return poseidon2([ownerPkX, ownerPkY, assetId, amount, blinding]);
}

/**
 * Scan a list of raw events for notes addressable to this wallet.
 *
 * The caller is expected to fetch raw events from Soroban RPC's getEvents and
 * decode them into the RawEvent shape (decoder lives in client/wallet.ts).
 */
export async function scanEvents(
  events: RawEvent[],
  keypair: ShieldedKeypair,
): Promise<ScanResult> {
  const newNotes: DiscoveredNote[] = [];
  const spentNullifiers: Field[] = [];
  let highestLedger = 0;

  for (const ev of events) {
    if (ev.ledger > highestLedger) highestLedger = ev.ledger;

    // track spent nullifiers from transfer events (these are public).
    if (ev.nullifiers) {
      for (const n of ev.nullifiers) {
        const nf = bytes32ToField(n);
        if (nf !== 0n) spentNullifiers.push(nf);
      }
    }

    // try to decrypt the encrypted note.
    const decrypted = tryDecryptNote(
      { ciphertext: ev.encryptedNote, ephemeralPk: ev.ephemeralPk },
      keypair.viewingKey,
      keypair.shieldedPk.x,
      keypair.shieldedPk.y,
    );
    if (!decrypted) continue;

    // verify the commitment matches what the contract emitted.
    // (defense against malformed events: only accept notes whose
    // recomputed commitment matches the on-chain leaf.)
    const expectedCommitment = await computeCommitment(
      decrypted.ownerPkX,
      decrypted.ownerPkY,
      decrypted.assetId,
      decrypted.amount,
      decrypted.blinding,
    );
    const onChainCommitment = bytes32ToField(ev.commitment);
    if (expectedCommitment !== onChainCommitment) continue;

    const nullifier = await deriveNullifierExact(
      keypair.spendingKey,
      onChainCommitment,
      ev.leafIndex,
    );

    newNotes.push({
      ...decrypted,
      commitment: onChainCommitment,
      leafIndex: ev.leafIndex,
      nullifier,
      spent: false,
    });
  }

  return { newNotes, spentNullifiers, highestLedger };
}
