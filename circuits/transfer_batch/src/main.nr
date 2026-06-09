// transfer_batch/src/main.nr
// single-transaction shielded -> shielded batch transfer (payroll), railgun-style.
// 16 input notes (padded with dummies) -> 12 output notes. up to 10 real
// recipients + change to self; unused output slots are zero-value decoys to self
// so the real recipient count is hidden behind a uniform 12-output shape.
// public inputs (verifier interface order):
// pool_root, nullifier_1..16, out_commitment_1..12, asset_id, fee, tx_hash (= 32)

use lib_shield::joinsplit::transfer_batch_main;

fn main(
    pool_root: pub Field,
    nullifiers: pub [Field; 16],
    out_commitments: pub [Field; 12],
    asset_id: pub Field,
    fee: pub Field,
    tx_hash: pub Field,

    spending_key: Field,
    signature: [u8; 64],
    in_amounts: [Field; 16],
    in_blindings: [Field; 16],
    in_indices: [Field; 16],
    in_paths: [[Field; 32]; 16],
    in_path_indices: [[bool; 32]; 16],
    out_pk_x: [Field; 12],
    out_pk_y: [Field; 12],
    out_amounts: [Field; 12],
    out_blindings: [Field; 12],
) {
    transfer_batch_main(
        pool_root, nullifiers, out_commitments, asset_id, fee, tx_hash,
        spending_key, signature, in_amounts, in_blindings, in_indices,
        in_paths, in_path_indices, out_pk_x, out_pk_y, out_amounts, out_blindings,
    );
}
