// sdk/src/utils/types.ts

/** A 32-byte hash, hex-encoded (with 0x prefix). */
export type Hex = `0x${string}`;

/** A Field element — bigint in [0, BN254_FIELD_PRIME).
 *
 * IMPORTANT: Noir's `Field` type is the BN254 *scalar* field, which equals
 * the Grumpkin *base* field. Its prime is GRUMPKIN_ORDER below.
 *
 * The BN254 *base* field (0x...2833...0001) is a different prime and is NOT
 * what Noir / Barretenberg uses for field arithmetic. Every range check in
 * the SDK must use GRUMPKIN_ORDER, not the base field.
 */
export type Field = bigint;

/**
 * BN254 scalar field prime = Grumpkin base field prime.
 * This is the prime that Noir's `Field` type uses.
 *
 * 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
 */
export const BN254_FIELD_PRIME =
  0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

/**
 * Grumpkin scalar field order = BN254 base field prime.
 * Used for Schnorr key arithmetic (spending key, ephemeral keys).
 *
 * 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
 *
 * Note: this is SMALLER than BN254_FIELD_PRIME. Spending keys derived
 * mod GRUMPKIN_SCALAR_ORDER are always valid BN254_FIELD_PRIME values too.
 */
export const GRUMPKIN_SCALAR_ORDER =
  0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** BabyJubJub subgroup order (not used in current circuits — kept for reference). */
export const BJJ_SUBGROUP_ORDER =
  0x0e7db4ea6533afa906673b0101343b00aa77b4805fffcb7fdfffffffe00000001n;

/** BabyJubJub curve point in affine coordinates. */
export interface CurvePoint {
  x: Field;
  y: Field;
}

/** A user's complete shielded identity. */
export interface ShieldedKeypair {
  /** 32-byte spending key mod GRUMPKIN_SCALAR_ORDER. */
  spendingKey: Field;
  /** Derived viewing key — for scanning without spending power. */
  viewingKey: Field;
  /** spendingKey * G on Grumpkin — the user's public "address". */
  shieldedPk: CurvePoint;
  /** viewingKey * G — used by senders to encrypt notes. */
  viewingPk: CurvePoint;
}

/** A note before it's committed — the spendable unit of value. */
export interface Note {
  ownerPkX: Field;
  ownerPkY: Field;
  assetId: Field;
  amount: bigint;
  blinding: Field;
}

/** A note observed on-chain at a specific tree index. */
export interface DiscoveredNote extends Note {
  commitment: Field;
  leafIndex: number;
  nullifier: Field;
  spent: boolean;
}

/** Public inputs for the transfer circuit. */
export interface TransferPublicInputs {
  poolRoot: Field;
  nullifier1: Field;
  nullifier2: Field;
  outputCommitment1: Field;
  outputCommitment2: Field;
  assetId: Field;
  fee: bigint;
  txHash: Field;
}

/** Public inputs for the deposit circuit. */
export interface DepositPublicInputs {
  outputCommitment: Field;
  assetId: Field;
  amount: bigint;
}

/** Public inputs for the withdraw circuit. */
export interface WithdrawPublicInputs {
  poolRoot: Field;
  nullifier: Field;
  assetId: Field;
  withdrawAmount: bigint;
  fee: bigint;
  recipientStellarHash: Field;
  txHash: Field;
}

/** A constructed proof ready to submit. */
export interface ZkProof {
  proofBytes: Uint8Array;
  publicInputs: Field[];
}

/** Encrypted note payload emitted on-chain. */
export interface EncryptedNotePayload {
  ciphertext: Uint8Array;
  ephemeralPk: Uint8Array;
}
