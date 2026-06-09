// sdk/src/client/proofs.ts
// client-side ultrahonk proof generation.
// toolchain versions (officially paired — from bb-versions.json):
// nargo : 1.0.0-beta.19
// bb cli : 4.0.0-nightly.20260120
// bb.js : 4.0.0-nightly.20260120 (@aztec/bb.js)
// noir_js: 1.0.0-beta.19 (@noir-lang/noir_js)
// proving flow (documented, stable api for bb.js v3/v4):
// 1. const noir = new noir(circuit)
// 2. const { witness } = await noir.execute(inputs)
// 3. const backend = new ultrahonkbackend(circuit.bytecode)
// 4. const { proof, publicinputs } = await backend.generateproof(witness)
// this is the api shown in official noir docs and all known working examples.
// do not use circuitprove / circuitcomputevk — those are internal apis from
// unreleased nightly versions (5.0.0+) with no stability guarantees.

import type {
  Field, ZkProof, DepositPublicInputs,
  TransferPublicInputs, WithdrawPublicInputs, ShieldedKeypair,
} from '../utils/types.js';
import { fieldToHex } from '../utils/encoding.js';

export interface CircuitArtifact {
  circuit: any;
}

export interface CircuitArtifacts {
  transfer: CircuitArtifact;
  deposit:  CircuitArtifact;
  withdraw: CircuitArtifact;
}

// lazy singletons

let _noirJs: any = null;
let _bbJs: any = null;

async function getNoirJs() {
  if (!_noirJs) _noirJs = await import('@noir-lang/noir_js');
  return _noirJs;
}

async function getBbJs() {
  if (!_bbJs) _bbJs = await import('@aztec/bb.js');
  return _bbJs;
}

// helpers

function bufToBigint(buf: Uint8Array | string): bigint {
  if (typeof buf === 'string') return BigInt(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

// proofgenerator

interface BackendBag {
  deposit:  any;
  transfer: any;
  withdraw: any;
}

export class ProofGenerator {
  private constructor(
    private artifacts: CircuitArtifacts,
    private noirJs: any,
    private backends: BackendBag,
  ) {}

  static async init(artifacts: CircuitArtifacts): Promise<ProofGenerator> {
    const [noirJs, bbJs] = await Promise.all([getNoirJs(), getBbJs()]);
    const { UltraHonkBackend } = bbJs;

    // one backend per circuit — ultrahonkbackend manages the wasm internally.
    const mkBackend = (acir: any) => new UltraHonkBackend(acir.bytecode, {
      threads: typeof navigator !== 'undefined'
        ? Math.max(1, Math.min(8, Math.floor(((navigator as any).hardwareConcurrency ?? 4) / 2)))
        : 4,
    });

    const backends: BackendBag = {
      deposit:  mkBackend(artifacts.deposit.circuit),
      transfer: mkBackend(artifacts.transfer.circuit),
      withdraw: mkBackend(artifacts.withdraw.circuit),
    };

    return new ProofGenerator(artifacts, noirJs, backends);
  }

  async destroy(): Promise<void> {
    for (const b of Object.values(this.backends)) {
      try { await b.destroy?.(); } catch { /* ignore */ }
    }
  }

  // abi input builders

  buildDepositInputs(input: {
    public: DepositPublicInputs;
    private: { ownerPkX: Field; ownerPkY: Field; blinding: Field };
  }): Record<string, string> {
    return {
      output_commitment: fieldToHex(input.public.outputCommitment),
      asset_id:          fieldToHex(input.public.assetId),
      amount:            fieldToHex(input.public.amount),
      owner_pk_x:        fieldToHex(input.private.ownerPkX),
      owner_pk_y:        fieldToHex(input.private.ownerPkY),
      blinding:          fieldToHex(input.private.blinding),
    };
  }

  buildTransferInputs(input: {
    public: TransferPublicInputs;
    private: {
      keypair: ShieldedKeypair;
      signature: Uint8Array;
      in1: { amount: bigint; blinding: Field; index: number; path: Field[]; pathIndices: (0|1)[] };
      in2: { amount: bigint; blinding: Field; index: number; path: Field[]; pathIndices: (0|1)[] } | null;
      out1: { ownerPkX: Field; ownerPkY: Field; amount: bigint; blinding: Field };
      out2: { ownerPkX: Field; ownerPkY: Field; amount: bigint; blinding: Field } | null;
    };
  }): Record<string, any> {
    const in2 = input.private.in2 ?? {
      amount: 0n, blinding: 0n, index: 0,
      path: Array(32).fill(0n) as Field[],
      pathIndices: Array(32).fill(0) as (0|1)[],
    };
    const out2 = input.private.out2 ?? { ownerPkX: 0n, ownerPkY: 0n, amount: 0n, blinding: 0n };
    return {
      pool_root:          fieldToHex(input.public.poolRoot),
      nullifier1:         fieldToHex(input.public.nullifier1),
      nullifier2:         fieldToHex(input.public.nullifier2),
      output_commitment1: fieldToHex(input.public.outputCommitment1),
      output_commitment2: fieldToHex(input.public.outputCommitment2),
      asset_id:           fieldToHex(input.public.assetId),
      fee:                fieldToHex(input.public.fee),
      tx_hash:            fieldToHex(input.public.txHash),
      spending_key:       fieldToHex(input.private.keypair.spendingKey),
      signature:          Array.from(input.private.signature).map(String),
      in1_amount:         fieldToHex(input.private.in1.amount),
      in1_blinding:       fieldToHex(input.private.in1.blinding),
      in1_index:          String(input.private.in1.index),
      in1_path:           input.private.in1.path.map(fieldToHex),
      in1_path_indices:   input.private.in1.pathIndices.map(String),
      in2_amount:         fieldToHex(in2.amount),
      in2_blinding:       fieldToHex(in2.blinding),
      in2_index:          String(in2.index),
      in2_path:           in2.path.map(fieldToHex),
      in2_path_indices:   in2.pathIndices.map(String),
      out1_owner_pk_x:    fieldToHex(input.private.out1.ownerPkX),
      out1_owner_pk_y:    fieldToHex(input.private.out1.ownerPkY),
      out1_amount:        fieldToHex(input.private.out1.amount),
      out1_blinding:      fieldToHex(input.private.out1.blinding),
      out2_owner_pk_x:    fieldToHex(out2.ownerPkX),
      out2_owner_pk_y:    fieldToHex(out2.ownerPkY),
      out2_amount:        fieldToHex(out2.amount),
      out2_blinding:      fieldToHex(out2.blinding),
    };
  }

  buildWithdrawInputs(input: {
    public: WithdrawPublicInputs;
    private: {
      keypair: ShieldedKeypair;
      signature: Uint8Array;
      noteAmount: bigint;
      noteBlinding: Field;
      noteIndex: number;
      notePath: Field[];
      notePathIndices: (0|1)[];
      recipientAddressField: Field;
    };
  }): Record<string, any> {
    return {
      pool_root:               fieldToHex(input.public.poolRoot),
      nullifier:               fieldToHex(input.public.nullifier),
      asset_id:                fieldToHex(input.public.assetId),
      withdraw_amount:         fieldToHex(input.public.withdrawAmount),
      fee:                     fieldToHex(input.public.fee),
      recipient_stellar_hash:  fieldToHex(input.public.recipientStellarHash),
      tx_hash:                 fieldToHex(input.public.txHash),
      spending_key:            fieldToHex(input.private.keypair.spendingKey),
      signature:               Array.from(input.private.signature).map(String),
      note_amount:             fieldToHex(input.private.noteAmount),
      note_blinding:           fieldToHex(input.private.noteBlinding),
      note_index:              String(input.private.noteIndex),
      note_path:               input.private.notePath.map(fieldToHex),
      note_path_indices:       input.private.notePathIndices.map(String),
      recipient_address_field: fieldToHex(input.private.recipientAddressField),
    };
  }

  // prove methods

  async proveDeposit(
    input: Parameters<ProofGenerator['buildDepositInputs']>[0],
  ): Promise<ZkProof> {
    return this.prove('deposit', this.buildDepositInputs(input));
  }

  async proveTransfer(
    input: Parameters<ProofGenerator['buildTransferInputs']>[0],
  ): Promise<ZkProof> {
    return this.prove('transfer', this.buildTransferInputs(input));
  }

  async proveWithdraw(
    input: Parameters<ProofGenerator['buildWithdrawInputs']>[0],
  ): Promise<ZkProof> {
    return this.prove('withdraw', this.buildWithdrawInputs(input));
  }

  private async prove(
    circuitName: 'deposit' | 'transfer' | 'withdraw',
    abiInputs: Record<string, any>,
  ): Promise<ZkProof> {
    const acir = this.artifacts[circuitName].circuit;
    const backend = this.backends[circuitName];

    // step 1: execute the circuit to get the witness.
    const noir = new this.noirJs.Noir(acir);
    const { witness } = await noir.execute(abiInputs);

    // step 2: generate the ultrahonk proof.
    // generateproof returns { proof: uint8array, publicinputs: string[] }
    // publicinputs are hex strings of 32-byte be field elements.
    const result = await backend.generateProof(witness);

    return {
      proofBytes:   result.proof,
      publicInputs: (result.publicInputs as (string | Uint8Array)[]).map(bufToBigint),
    };
  }
}
