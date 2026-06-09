// sdk/src/client/wallet.ts
// high-level shield wallet orchestrating notes, scanning, and transactions.

import { rpc } from '@stellar/stellar-sdk';
import { randomBytes } from '@noble/hashes/utils.js';

import { poseidon2 } from '../crypto/poseidon.js';
import {
  generateShieldedKeypair, deriveKeypairFromSpendingKey,
  encodeShieldedAddress, decodeShieldedAddress,
  deriveNullifierExact, stellarAddressToHash,
} from '../crypto/keys.js';
import { signSchnorr } from '../crypto/schnorr.js';
import { encryptNote } from '../crypto/noteEncryption.js';
import { ProofGenerator } from './proofs.js';
import { IncrementalMerkleTree, POOL_DEPTH } from '../scanner/merkleTree.js';
import { scanEvents, type RawEvent } from '../scanner/noteScanner.js';
import { fieldToBytes32, bytes32ToField, fieldToHex, bytesToBigInt } from '../utils/encoding.js';
import { GRUMPKIN_ORDER } from '../crypto/schnorr.js';

import type {
  ShieldedKeypair, DiscoveredNote, Field, Note, CurvePoint,
} from '../utils/types.js';

export interface ShieldWalletConfig {
  rpcUrl: string;
  networkPassphrase: string;
  poolContract: string;     // contract C... address
  proofGenerator: ProofGenerator;
  indexerUrl?: string;      // e.g. 'http://localhost:3001'. If omitted, single-user mode.
}

export interface PendingTransfer {
  recipientShieldedAddress: string;
  assetId: Field;
  amount: bigint;
  fee: bigint;
}

/**
 * The Shield wallet class. Holds keys, the local Merkle tree, and the
 * discovered notes. Talks to Soroban via stellar-sdk.
 */
export class ShieldWallet {
  private keypair: ShieldedKeypair;
  private tree = new IncrementalMerkleTree(POOL_DEPTH);
  private notes: Map<string, DiscoveredNote> = new Map();   // commitmentHex -> note
  private spentNullifiers: Set<string> = new Set();         // nullifierHex
  private lastSyncedLedger = 0;

  private rpc: rpc.Server;

  constructor(
    keypair: ShieldedKeypair,
    private readonly config: ShieldWalletConfig,
  ) {
    this.keypair = keypair;
    this.rpc = new rpc.Server(config.rpcUrl);
  }

  // static factories

  static async create(config: ShieldWalletConfig): Promise<ShieldWallet> {
    const keypair = await generateShieldedKeypair();
    return new ShieldWallet(keypair, config);
  }

  static async fromSpendingKey(spendingKey: Field, config: ShieldWalletConfig): Promise<ShieldWallet> {
    const keypair = await deriveKeypairFromSpendingKey(spendingKey);
    return new ShieldWallet(keypair, config);
  }

  // public properties

  get shieldedAddress(): string {
    return encodeShieldedAddress(this.keypair.shieldedPk, this.keypair.viewingPk);
  }

  get shieldedPk(): CurvePoint {
    return this.keypair.shieldedPk;
  }

  get viewingPublicKey(): CurvePoint {
    return this.keypair.viewingPk;
  }

  /** Total balance per asset_id (only unspent notes). */
  balances(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const note of this.notes.values()) {
      if (note.spent) continue;
      const key = fieldToHex(note.assetId);
      out.set(key, (out.get(key) ?? 0n) + note.amount);
    }
    return out;
  }

  unspentNotes(): DiscoveredNote[] {
    return [...this.notes.values()].filter(n => !n.spent);
  }

  // sync (scan events from rpc)

  async sync(): Promise<{ added: number; spent: number; ledger: number }> {
    // fetch events from the pool contract since lastsyncedledger.
    // for brevity we sketch the call; the real implementation uses
    // rpc.getevents with the contract id and event topics.
    const events = await this.fetchPoolEvents(this.lastSyncedLedger);

    const result = await scanEvents(events, this.keypair);

    for (const note of result.newNotes) {
      const key = fieldToHex(note.commitment);
      // de-dup
      if (!this.notes.has(key)) {
        this.notes.set(key, note);
      }
    }
    for (const nf of result.spentNullifiers) {
      const nfKey = fieldToHex(nf);
      this.spentNullifiers.add(nfKey);
      // mark any owned note with this nullifier as spent
      for (const note of this.notes.values()) {
        if (fieldToHex(note.nullifier) === nfKey) note.spent = true;
      }
    }

    // reconstruct the local merkle tree from all known commitments.
    // (sorted by leaf_index ascending.)
    const sorted = [...this.notes.values()].sort((a, b) => a.leafIndex - b.leafIndex);
    this.tree = new IncrementalMerkleTree(POOL_DEPTH);
    // note: for a fully correct local view wed need all on-chain commitments,
    // not just our own. for v1 demo we fetch all commitments via a separate
    // query (see fetchallcommitments). in production, a tree-state-server or
    // light-client circuit can compress this.
    const allCommitments = await this.fetchAllCommitments();
    for (const c of allCommitments) this.tree.insert(c);

    this.lastSyncedLedger = result.highestLedger;
    return {
      added: result.newNotes.length,
      spent: result.spentNullifiers.length,
      ledger: result.highestLedger,
    };
  }

  // compute commitment for a note (matches circuit)

  private async computeCommitment(note: Note): Promise<Field> {
    return poseidon2([
      note.ownerPkX, note.ownerPkY, note.assetId, note.amount, note.blinding,
    ]);
  }

  // build a deposit transaction
  // the user is depositing `amount` of `assetid` from their own stellar account.
  // the output note will be addressed to themselves (private balance increase).

  /**
   * Build a deposit proof + commitment.
   *
   * `grossAmount` is the amount the user is sending into the pool from their
   * public Stellar account. The pool deducts a protocol fee internally and
   * mints a note for `grossAmount - fee`. The SDK must mint the note for the
   * SAME net amount the contract will use as the proof's public input.
   *
   * @param feeBps the protocol fee in basis points configured on the pool
   *               (read this from the pool's view; default 10 = 0.1%)
   */
  async buildDeposit(
    assetId: Field,
    grossAmount: bigint,
    feeBps: number = 10,
  ): Promise<{
    note: Note;
    commitment: Field;
    netAmount: bigint;
    proof: Awaited<ReturnType<ProofGenerator['proveDeposit']>>;
    encryptedNote: { ciphertext: Uint8Array; ephemeralPk: Uint8Array };
  }> {
    const feeAmount = (grossAmount * BigInt(feeBps)) / 10_000n;
    const netAmount = grossAmount - feeAmount;
    if (netAmount <= 0n) throw new Error('Net amount after fee is non-positive');

    const blinding = bytesToBigInt(randomBytes(32)) % GRUMPKIN_ORDER;
    const note: Note = {
      ownerPkX: this.keypair.shieldedPk.x,
      ownerPkY: this.keypair.shieldedPk.y,
      assetId,
      amount: netAmount,
      blinding,
    };
    const commitment = await this.computeCommitment(note);

    const proof = await this.config.proofGenerator.proveDeposit({
      public: { outputCommitment: commitment, assetId, amount: netAmount },
      private: {
        ownerPkX: note.ownerPkX,
        ownerPkY: note.ownerPkY,
        blinding: note.blinding,
      },
    });

    const encryptedNote = await encryptNote(note, this.keypair.viewingPk);
    return { note, commitment, netAmount, proof, encryptedNote };
  }

  // build a shielded transfer

  async buildTransfer(req: PendingTransfer): Promise<{
    proof: Awaited<ReturnType<ProofGenerator['proveTransfer']>>;
    publicInputs: any;
    encryptedNotes: { ciphertext: Uint8Array; ephemeralPk: Uint8Array }[];
  }> {
    // decode full combined address — gets both spending_pk and viewing_pk.
    // no off-band key exchange needed: viewing_pk is embedded in the address.
    const decoded = decodeShieldedAddress(req.recipientShieldedAddress);
    const recipientPk = decoded.spendingPk;
    const recipientViewingPk = decoded.viewingPk;

    // 1. pick input notes: smallest unspent notes of the same asset that
    // sum to >= amount + fee.
    const total = req.amount + req.fee;
    const candidates = this.unspentNotes()
      .filter(n => n.assetId === req.assetId)
      .sort((a, b) => Number(a.amount - b.amount));

    let inputs: DiscoveredNote[] = [];
    let acc = 0n;
    for (const c of candidates) {
      inputs.push(c);
      acc += c.amount;
      if (acc >= total) break;
      if (inputs.length >= 2) break;
    }
    if (acc < total) throw new Error('Insufficient shielded balance');
    if (inputs.length === 0) throw new Error('No notes available');

    // 2. compute change amount.
    const changeAmount = acc - total;
    const blindingChange = bytesToBigInt(randomBytes(32)) % GRUMPKIN_ORDER;
    const blindingRecipient = bytesToBigInt(randomBytes(32)) % GRUMPKIN_ORDER;

    // 3. build output notes.
    const recipientNote: Note = {
      ownerPkX: recipientPk.x,
      ownerPkY: recipientPk.y,
      assetId: req.assetId,
      amount: req.amount,
      blinding: blindingRecipient,
    };
    const changeNote: Note | null = changeAmount > 0n ? {
      ownerPkX: this.keypair.shieldedPk.x,
      ownerPkY: this.keypair.shieldedPk.y,
      assetId: req.assetId,
      amount: changeAmount,
      blinding: blindingChange,
    } : null;

    const out1Commit = await this.computeCommitment(recipientNote);
    const out2Commit = changeNote ? await this.computeCommitment(changeNote) : 0n;

    // 4. compute nullifiers (re-derive in case stored value is stale).
    const null1 = await deriveNullifierExact(this.keypair.spendingKey, inputs[0]!.commitment, inputs[0]!.leafIndex);
    const null2 = inputs[1]
      ? await deriveNullifierExact(this.keypair.spendingKey, inputs[1].commitment, inputs[1].leafIndex)
      : 0n;

    // 5. get merkle proofs for each input.
    const proof1 = await this.tree.getProof(inputs[0]!.leafIndex);
    const proof2 = inputs[1] ? await this.tree.getProof(inputs[1].leafIndex) : { path: Array(32).fill(0n), indices: Array(32).fill(0) as (0|1)[] };

    // 6. compute tx_hash binding all public inputs + contract domain.
    const contractField = await this.poolContractAsField();
    const poolRoot = await this.tree.getRoot();
    const txHash = await poseidon2([
      contractField,
      poolRoot,
      null1,
      null2,
      out1Commit,
    ]);

    // 7. sign tx_hash with the spending key (schnorr over grumpkin).
    const txHashBytes = fieldToBytes32(txHash);
    const signature = await signSchnorr(this.keypair.spendingKey, txHashBytes);

    // 8. generate the proof.
    const proof = await this.config.proofGenerator.proveTransfer({
      public: {
        poolRoot,
        nullifier1: null1,
        nullifier2: null2,
        outputCommitment1: out1Commit,
        outputCommitment2: out2Commit,
        assetId: req.assetId,
        fee: req.fee,
        txHash,
      },
      private: {
        keypair: this.keypair,
        signature,
        in1: {
          amount: inputs[0]!.amount,
          blinding: inputs[0]!.blinding,
          index: inputs[0]!.leafIndex,
          path: proof1.path,
          pathIndices: proof1.indices,
        },
        in2: inputs[1] ? {
          amount: inputs[1].amount,
          blinding: inputs[1].blinding,
          index: inputs[1].leafIndex,
          path: proof2.path,
          pathIndices: proof2.indices,
        } : null,
        out1: {
          ownerPkX: recipientNote.ownerPkX,
          ownerPkY: recipientNote.ownerPkY,
          amount: recipientNote.amount,
          blinding: recipientNote.blinding,
        },
        out2: changeNote ? {
          ownerPkX: changeNote.ownerPkX,
          ownerPkY: changeNote.ownerPkY,
          amount: changeNote.amount,
          blinding: changeNote.blinding,
        } : null,
      },
    });

    const encryptedNotes = [
      await encryptNote(recipientNote, recipientViewingPk),
    ];
    if (changeNote) {
      encryptedNotes.push(await encryptNote(changeNote, this.keypair.viewingPk));
    }

    return {
      proof,
      publicInputs: {
        poolRoot,
        nullifier1: null1,
        nullifier2: null2,
        outputCommitment1: out1Commit,
        outputCommitment2: out2Commit,
        assetId: req.assetId,
        fee: req.fee,
        txHash,
      },
      encryptedNotes,
    };
  }

  // build a withdrawal

  /**
   * Build a withdrawal proof.
   *
   * @param requestedAmount - the amount to withdraw (not including fee).
   *   If omitted, withdraws the full amount of the first matching note.
   *   If a note is too small, the wallet first uses buildTransfer internally
   *   to merge notes — but for v1 we do direct single-note withdraw only
   *   and throw if no single note covers the requested amount.
   */
  async buildWithdraw(
    assetId: Field,
    recipientStellarAddress: string,
    fee: bigint,
    requestedAmount?: bigint,
  ): Promise<{
    proof: Awaited<ReturnType<ProofGenerator['proveWithdraw']>>;
    publicInputs: any;
  }> {
    // find the smallest note that covers requestedamount + fee.
    const minNeeded = requestedAmount != null ? requestedAmount + fee : 0n;
    const candidates = this.unspentNotes()
      .filter(n => n.assetId === assetId && n.amount > fee)
      .sort((a, b) => Number(a.amount - b.amount));
    const note = requestedAmount != null
      ? candidates.find(n => n.amount >= minNeeded)
      : candidates[0];
    if (!note) throw new Error('No note of this asset with sufficient balance');
    if (note.amount <= fee) throw new Error('Note too small to cover fee');
    const withdrawAmount = requestedAmount != null ? requestedAmount : note.amount - fee;
    if (withdrawAmount + fee > note.amount) throw new Error('Requested amount exceeds note balance');

    // hash the recipients stellar address string as utf-8 bytes.
    // pool contract does: sha256(addr.to_string().as_bytes()) via hash_address().
    const recipientHash = stellarAddressToHash(
      new TextEncoder().encode(recipientStellarAddress.trim())
    );
    const recipientField = recipientHash;

    const merkleProof = await this.tree.getProof(note.leafIndex);

    // tx_hash binds proof to (pool contract, root, nullifier, recipient).
    const contractField = await this.poolContractAsField();
    const poolRoot = await this.tree.getRoot();
    const txHash = await poseidon2([
      contractField,
      poolRoot,
      note.nullifier,
      assetId,
      recipientHash,
    ]);
    const txHashBytes = fieldToBytes32(txHash);
    const signature = await signSchnorr(this.keypair.spendingKey, txHashBytes);

    const proof = await this.config.proofGenerator.proveWithdraw({
      public: {
        poolRoot,
        nullifier: note.nullifier,
        assetId,
        withdrawAmount,
        fee,
        recipientStellarHash: recipientHash,
        txHash,
      },
      private: {
        keypair: this.keypair,
        signature,
        noteAmount: note.amount,
        noteBlinding: note.blinding,
        noteIndex: note.leafIndex,
        notePath: merkleProof.path,
        notePathIndices: merkleProof.indices,
        recipientAddressField: recipientField,
      },
    });

    return {
      proof,
      publicInputs: {
        poolRoot,
        nullifier: note.nullifier,
        assetId,
        withdrawAmount,
        fee,
        recipientStellarHash: recipientHash,
        txHash,
      },
    };
  }

  // internal: rpc helpers

  /**
   * Hash the pool contract address into a Field for domain separation.
   */
  private _cachedPoolField: Field | null = null;
  private async poolContractAsField(): Promise<Field> {
    if (this._cachedPoolField !== null) return this._cachedPoolField;
    // hash pool contract address string as utf-8 — matches pool hash_address().
    this._cachedPoolField = stellarAddressToHash(
      new TextEncoder().encode(this.config.poolContract)
    );
    return this._cachedPoolField;
  }

  /**
   * Fetch events from the indexer service.
   * The indexer parses Soroban XDR events and returns them in RawEvent format.
   */
  private async fetchPoolEvents(sinceLedger: number): Promise<RawEvent[]> {
    if (!this.config.indexerUrl) return [];
    try {
      const url = `${this.config.indexerUrl}/events?since=${sinceLedger}`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.events || []).map((e: any) => ({
        ledger: e.ledger,
        topic: e.topic,
        encryptedNote: new Uint8Array(e.encryptedNote),
        ephemeralPk: new Uint8Array(e.ephemeralPk),
        commitment: new Uint8Array(e.commitment),
        leafIndex: e.leafIndex,
        nullifiers: e.nullifiers?.map((n: number[]) => new Uint8Array(n)),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fetch ALL commitments from the indexer to rebuild the global Merkle tree.
   */
  private async fetchAllCommitments(): Promise<Field[]> {
    if (!this.config.indexerUrl) {
      // fallback: local notes only (single-user demo mode)
      return [...this.notes.values()]
        .sort((a, b) => a.leafIndex - b.leafIndex)
        .map(n => n.commitment);
    }
    try {
      const url = `${this.config.indexerUrl}/commitments`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.commitments || []).map((h: string) => BigInt(h));
    } catch {
      return [];
    }
  }
}
