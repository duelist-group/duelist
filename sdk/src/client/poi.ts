// sdk/src/client/poi.ts
// proof of innocence (poi) generator.
// this module generates a zk proof that a users specific note does not
// trace back to any address in the compliance blacklist. the proof is:
// "my commitment c exists in the pool at leaf_index l, and the source
// address that deposited into this position is not in the blacklist
// merkle tree with root r_blacklist."
// this is an opt-in proof — the user generates it locally and presents
// it to a regulator, exchange, or counterparty on request. it is not
// enforced by the transfer/withdraw circuits (railgun model).
// the proof works by:
// 1. user knows their note (amount, blinding, asset_id, owner_pk)
// 2. user knows the deposit that created this note (deposit tx, source address)
// 3. user proves:
// a. the note commitment is correctly formed
// b. the commitment exists in the pool tree (merkle inclusion)
// c. the source address is not in the blacklist tree (merkle non-membership)
// for v1, we implement a simplified version that generates an attestation
// document (signed by the users viewing key) rather than a full zk proof.
// a full zk poi circuit is planned for v2.

import { sha256 } from '@noble/hashes/sha2.js';
import { poseidon2 } from '../crypto/poseidon.js';
import { fieldToBytes32, bytes32ToField, bytesToHex } from '../utils/encoding.js';
import { signSchnorr, verifySchnorr } from '../crypto/schnorr.js';
import type { Field, DiscoveredNote, ShieldedKeypair } from '../utils/types.js';

export interface POIAttestation {
  /** Version of the POI format */
  version: 1;
  /** The note commitment being attested */
  commitment: string;   // hex
  /** The asset id */
  assetId: string;      // hex
  /** The amount (in stroops) */
  amount: string;       // decimal
  /** The leaf index in the pool tree */
  leafIndex: number;
  /** The pool root at time of attestation */
  poolRoot: string;     // hex
  /** The blacklist root at time of attestation */
  blacklistRoot: string; // hex
  /** The source Stellar address that deposited this note */
  sourceAddress: string;
  /** SHA-256 hash of the above fields, signed by the user */
  attestationHash: string; // hex
  /** Schnorr signature over attestationHash by the spending key */
  signature: string;    // hex
  /** Public key (x coordinate) of the signer */
  signerPkX: string;    // hex
  /** Public key (y coordinate) of the signer */
  signerPkY: string;    // hex
  /** Timestamp of attestation */
  timestamp: number;
}

/**
 * Generate a POI attestation for a specific note.
 *
 * This proves that the user's note was deposited by `sourceAddress` which
 * the user claims is not on any sanctions list. A verifier can independently
 * check the sourceAddress against OFAC and verify the signature.
 *
 * For a full ZK POI (v2), this would be replaced with a Noir circuit that
 * proves non-membership without revealing the source address.
 */
export async function generatePOIAttestation(
  note: DiscoveredNote,
  keypair: ShieldedKeypair,
  poolRoot: Field,
  blacklistRoot: Field,
  sourceAddress: string,
): Promise<POIAttestation> {
  // 1. verify the note commitment is correctly formed
  const expectedCommitment = await poseidon2([
    note.ownerPkX, note.ownerPkY, note.assetId, note.amount, note.blinding,
  ]);
  if (expectedCommitment !== note.commitment) {
    throw new Error('Note commitment mismatch — cannot attest');
  }

  // 2. build the attestation payload
  const commitmentHex = bytesToHex(fieldToBytes32(note.commitment));
  const assetIdHex = bytesToHex(fieldToBytes32(note.assetId));
  const poolRootHex = bytesToHex(fieldToBytes32(poolRoot));
  const blacklistRootHex = bytesToHex(fieldToBytes32(blacklistRoot));
  const timestamp = Math.floor(Date.now() / 1000);

  // 3. hash the attestation payload
  const payloadStr = [
    'SHIELD-POI-v1',
    commitmentHex,
    assetIdHex,
    note.amount.toString(),
    note.leafIndex.toString(),
    poolRootHex,
    blacklistRootHex,
    sourceAddress,
    timestamp.toString(),
  ].join('|');
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const attestationHash = sha256(payloadBytes);

  // 4. sign with the spending key
  const signature = await signSchnorr(keypair.spendingKey, attestationHash);

  return {
    version: 1,
    commitment: commitmentHex,
    assetId: assetIdHex,
    amount: note.amount.toString(),
    leafIndex: note.leafIndex,
    poolRoot: poolRootHex,
    blacklistRoot: blacklistRootHex,
    sourceAddress,
    attestationHash: bytesToHex(attestationHash),
    signature: bytesToHex(signature),
    signerPkX: bytesToHex(fieldToBytes32(keypair.shieldedPk.x)),
    signerPkY: bytesToHex(fieldToBytes32(keypair.shieldedPk.y)),
    timestamp,
  };
}

/**
 * Verify a POI attestation's signature.
 *
 * A verifier then independently checks:
 *   1. The signature is valid (done here)
 *   2. The sourceAddress is not on OFAC SDN list (external check)
 *   3. The commitment exists in the pool at the claimed leaf_index (indexer query)
 *   4. The pool_root and blacklist_root match the on-chain state at the time
 */
export async function verifyPOIAttestation(attestation: POIAttestation): Promise<boolean> {
  try {
    const payloadStr = [
      'SHIELD-POI-v1',
      attestation.commitment,
      attestation.assetId,
      attestation.amount,
      attestation.leafIndex.toString(),
      attestation.poolRoot,
      attestation.blacklistRoot,
      attestation.sourceAddress,
      attestation.timestamp.toString(),
    ].join('|');
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const expectedHash = sha256(payloadBytes);

    // verify the hash matches
    if (bytesToHex(expectedHash) !== attestation.attestationHash) return false;

    // parse the signature and public key
    const sigBytes = hexToUint8(attestation.signature);
    const pkX = bytes32ToField(hexToUint8(attestation.signerPkX));
    const pkY = bytes32ToField(hexToUint8(attestation.signerPkY));

    return verifySchnorr(pkX, pkY, sigBytes, expectedHash);
  } catch {
    return false;
  }
}

function hexToUint8(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
