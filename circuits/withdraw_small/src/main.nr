// withdraw_small/src/main.nr
// single-transaction shielded -> public withdrawal, railgun-style.
// small bucket: up to 4 input notes (the fast/common case). inputs are padded
// with dummy zero-value notes to a fixed 4 so the real note count is hidden.
// public inputs (verifier interface order):
// pool_root, nullifier_1..4, change_commitment, decoy_commitment,
// asset_id, withdraw_amount, fee, recipient_stellar_hash, tx_hash (= 12)

use lib_shield::joinsplit::withdraw_main;

fn main(
    pool_root: pub Field,
    nullifiers: pub [Field; 4],
    change_commitment: pub Field,
    decoy_commitment: pub Field,
    asset_id: pub Field,
    withdraw_amount: pub Field,
    fee: pub Field,
    recipient_stellar_hash: pub Field,
    tx_hash: pub Field,

    spending_key: Field,
    signature: [u8; 64],
    in_amounts: [Field; 4],
    in_blindings: [Field; 4],
    in_indices: [Field; 4],
    in_paths: [[Field; 32]; 4],
    in_path_indices: [[bool; 32]; 4],
    change_amount: Field,
    change_blinding: Field,
    decoy_amount: Field,
    decoy_blinding: Field,
    recipient_address_field: Field,
) {
    withdraw_main(
        pool_root, nullifiers, change_commitment, decoy_commitment, asset_id,
        withdraw_amount, fee, recipient_stellar_hash, tx_hash,
        spending_key, signature, in_amounts, in_blindings, in_indices,
        in_paths, in_path_indices, change_amount, change_blinding,
        decoy_amount, decoy_blinding, recipient_address_field,
    );
}
