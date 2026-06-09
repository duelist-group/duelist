// joinsplit.nr
// shared multi-input note-spending logic for the railgun-style withdraw and
// batch-transfer circuits.
// a "joinsplit" consumes k input notes and produces m output notes (+ optional
// public leg for withdraw). inputs are expensive (each = a depth-32 merkle
// proof), so circuits are bucketed by n; outputs are cheap commitment hashes.
// dummy/decoy inputs: a slot with amount == 0 is inactive -- its merkle
// inclusion and index/path binding are skipped, but its nullifier is still
// derived from a (random-blinding) zero-value note so it looks indistinguishable
// from a real nullifier on-chain. this hides the real input count within a bucket.

use crate::merkle::{verify_merkle_inclusion, index_from_path};
use crate::babyjubjub::{derive_public_key, derive_nullifier, verify_signature};
use crate::note::{Note, compute_commitment, assert_amount_in_range, assert_output_value};
use crate::poseidon2;

/// process n input slots owned by `owner_pk` (derived from the spending key):
/// range-check every amount,
/// for active slots (amount != 0): verify merkle inclusion and bind the
/// nullifier index to the path position,
/// derive each nullifier and assert it equals the public nullifier,
/// enforce all n nullifiers are pairwise-distinct (blocks same-note reuse
/// and dummy/real collisions).
/// returns the sum of all input amounts (dummies contribute 0).
pub fn process_inputs<let N: u32>(
    spending_key: Field,
    owner_pk_x: Field,
    owner_pk_y: Field,
    asset_id: Field,
    pool_root: Field,
    amounts: [Field; N],
    blindings: [Field; N],
    indices: [Field; N],
    paths: [[Field; 32]; N],
    path_indices: [[bool; 32]; N],
    nullifiers: [Field; N],
) -> Field {
    let mut total_in: Field = 0;

    for i in 0..N {
        assert_amount_in_range(amounts[i]);

        let note = Note {
            owner_pk_x,
            owner_pk_y,
            asset_id,
            amount: amounts[i],
            blinding: blindings[i],
        };
        let commitment = compute_commitment(note);

        let active = amounts[i] != 0;
        if active {
            verify_merkle_inclusion(commitment, paths[i], path_indices[i], pool_root);
            // bind the nullifier index to the merkle path position (no double-spend).
            assert(indices[i] == index_from_path(path_indices[i]), "Input index/path mismatch");
        }

        let computed_null = derive_nullifier(spending_key, commitment, indices[i]);
        assert(computed_null == nullifiers[i], "Nullifier mismatch");

        total_in += amounts[i];
    }

    // pairwise-distinct nullifiers (n is small; unrolled n^2/2 comparisons).
    for i in 0..N {
        for j in 0..N {
            if i < j {
                assert(nullifiers[i] != nullifiers[j], "Duplicate nullifier");
            }
        }
    }

    total_in
}

/// withdraw joinsplit: n shielded inputs -> public withdrawal + change + decoy.
/// public inputs (verifier interface order):
/// pool_root, nullifier_1..n, change_commitment, decoy_commitment,
/// asset_id, withdraw_amount, fee, recipient_stellar_hash, tx_hash
pub fn withdraw_main<let N: u32>(
    pool_root: Field,
    nullifiers: [Field; N],
    change_commitment: Field,
    decoy_commitment: Field,
    asset_id: Field,
    withdraw_amount: Field,
    fee: Field,
    recipient_stellar_hash: Field,
    tx_hash: Field,
    spending_key: Field,
    signature: [u8; 64],
    in_amounts: [Field; N],
    in_blindings: [Field; N],
    in_indices: [Field; N],
    in_paths: [[Field; 32]; N],
    in_path_indices: [[bool; 32]; N],
    change_amount: Field,
    change_blinding: Field,
    decoy_amount: Field,
    decoy_blinding: Field,
    recipient_address_field: Field,
) {
    let owner_pk = derive_public_key(spending_key);

    // F3: recompute tx_hash from the public inputs and bind the signature to it.
    // preimage order MUST match the worker (shieldWorker handleProveWithdraw):
    // pool_root, nullifier_1..n, change_commitment, decoy_commitment,
    // asset_id, withdraw_amount, fee, recipient_stellar_hash.
    // this makes the schnorr signature provably commit to the entire transaction
    // (root + every nullifier + both outputs + amounts + recipient), so a relayer
    // cannot reuse the proof with any altered field. pool_root is per-deployment,
    // which also blocks cross-pool replay.
    let mut preimage: [Field; N + 7] = [0; N + 7];
    preimage[0] = pool_root;
    for i in 0..N {
        preimage[1 + i] = nullifiers[i];
    }
    preimage[N + 1] = change_commitment;
    preimage[N + 2] = decoy_commitment;
    preimage[N + 3] = asset_id;
    preimage[N + 4] = withdraw_amount;
    preimage[N + 5] = fee;
    preimage[N + 6] = recipient_stellar_hash;
    let computed_tx_hash = poseidon2::hash(preimage, N + 7);
    assert(computed_tx_hash == tx_hash, "tx_hash mismatch");

    verify_signature(owner_pk.x, owner_pk.y, signature, tx_hash);

    assert_amount_in_range(withdraw_amount);
    assert_amount_in_range(fee);
    // F2: change + decoy are appended to the tree -> enforce the anti-dust floor.
    assert_output_value(change_amount);
    assert_output_value(decoy_amount);

    let total_in = process_inputs(
        spending_key, owner_pk.x, owner_pk.y, asset_id, pool_root,
        in_amounts, in_blindings, in_indices, in_paths, in_path_indices, nullifiers,
    );

    // change + decoy outputs are both self-owned commitments (decoy_amount is
    // 0 in normal use, but is included in the balance so it is always sound).
    let change_note = Note {
        owner_pk_x: owner_pk.x, owner_pk_y: owner_pk.y, asset_id,
        amount: change_amount, blinding: change_blinding,
    };
    assert(compute_commitment(change_note) == change_commitment, "Change commitment mismatch");

    let decoy_note = Note {
        owner_pk_x: owner_pk.x, owner_pk_y: owner_pk.y, asset_id,
        amount: decoy_amount, blinding: decoy_blinding,
    };
    assert(compute_commitment(decoy_note) == decoy_commitment, "Decoy commitment mismatch");

    // value balance: inputs == public withdrawal + fee + change + decoy.
    assert(
        total_in == withdraw_amount + fee + change_amount + decoy_amount,
        "Value balance violated",
    );

    // recipient binding: the contract independently re-hashes the recipient
    // address and checks it equals recipient_stellar_hash. we bind the public
    // input here so it is part of the proven statement.
    assert(recipient_address_field == recipient_stellar_hash, "Recipient mismatch");
}

/// batch-transfer joinsplit: n shielded inputs -> m shielded outputs.
/// public inputs (verifier interface order):
/// pool_root, nullifier_1..n, out_commitment_1..m, asset_id, fee, tx_hash
pub fn transfer_batch_main<let N: u32, let M: u32>(
    pool_root: Field,
    nullifiers: [Field; N],
    out_commitments: [Field; M],
    asset_id: Field,
    fee: Field,
    tx_hash: Field,
    spending_key: Field,
    signature: [u8; 64],
    in_amounts: [Field; N],
    in_blindings: [Field; N],
    in_indices: [Field; N],
    in_paths: [[Field; 32]; N],
    in_path_indices: [[bool; 32]; N],
    out_pk_x: [Field; M],
    out_pk_y: [Field; M],
    out_amounts: [Field; M],
    out_blindings: [Field; M],
) {
    let owner_pk = derive_public_key(spending_key);

    // F3: recompute tx_hash from the public inputs and bind the signature to it.
    // preimage order MUST match the worker (shieldWorker handleProveTransferBatch):
    // pool_root, nullifier_1..n, out_commitment_1..m, asset_id, fee.
    let mut preimage: [Field; N + M + 3] = [0; N + M + 3];
    preimage[0] = pool_root;
    for i in 0..N {
        preimage[1 + i] = nullifiers[i];
    }
    for j in 0..M {
        preimage[1 + N + j] = out_commitments[j];
    }
    preimage[N + M + 1] = asset_id;
    preimage[N + M + 2] = fee;
    let computed_tx_hash = poseidon2::hash(preimage, N + M + 3);
    assert(computed_tx_hash == tx_hash, "tx_hash mismatch");

    verify_signature(owner_pk.x, owner_pk.y, signature, tx_hash);
    assert_amount_in_range(fee);

    let total_in = process_inputs(
        spending_key, owner_pk.x, owner_pk.y, asset_id, pool_root,
        in_amounts, in_blindings, in_indices, in_paths, in_path_indices, nullifiers,
    );

    // each output is a well-formed commitment to (recipient_pk, asset, amount).
    // unused recipient slots are zero-value decoys to self -> uniform m-output
    // shape hides the real recipient count.
    let mut total_out: Field = fee;
    for j in 0..M {
        // F2: every appended output must be a zero decoy or >= min note value.
        assert_output_value(out_amounts[j]);
        let out_note = Note {
            owner_pk_x: out_pk_x[j],
            owner_pk_y: out_pk_y[j],
            asset_id,
            amount: out_amounts[j],
            blinding: out_blindings[j],
        };
        assert(compute_commitment(out_note) == out_commitments[j], "Output commitment mismatch");
        total_out += out_amounts[j];
    }

    assert(total_in == total_out, "Value balance violated");
}
