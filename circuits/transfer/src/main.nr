// transfer/src/main.nr
// shielded transfer (railgun-model: deposit gate, no poi in transfer).
// proves:
// 1. input ownership - prover holds the spending key for the input notes
// 2. input existence - input notes are commitments in the pool tree
// 3. nullifier validity - nullifiers correctly derived (anti-double-spend)
// 4. output correctness - output commitments well-formed
// 5. value balance - sum(inputs) == sum(outputs) + fee
// 6. asset consistency - all notes in the same asset
// 7. sig authorization - schnorr signature over tx_hash binds the entire transaction
// topology: 2 inputs, 2 outputs.
// set in2_amount = 0 to use only one input note.
// set out2_amount = 0 if no change note is needed.
// all amount fields are constrained to u128 range. field is the bn254 scalar
// (~254 bits) so additions of two u128 values cannot overflow field arithmetic.
// public inputs (in this exact order; this order is the verifier interface):
// pool_root, nullifier1, nullifier2,
// output_commitment1, output_commitment2,
// asset_id, fee, tx_hash

use lib_shield::merkle::verify_merkle_inclusion;
use lib_shield::merkle::compute_merkle_root;
use lib_shield::merkle::index_from_path;
use lib_shield::babyjubjub::{derive_public_key, derive_nullifier, verify_signature};
use lib_shield::note::{Note, compute_commitment, assert_amount_in_range, assert_amount_positive, assert_output_value};
use lib_shield::poseidon2;



fn main(
    // public inputs
    pool_root: pub Field,
    nullifier1: pub Field,
    nullifier2: pub Field,
    output_commitment1: pub Field,
    output_commitment2: pub Field,
    asset_id: pub Field,
    fee: pub Field,
    tx_hash: pub Field,

    // private: spending authorization
    spending_key: Field,
    signature: [u8; 64],

    // private: input note 1
    in1_amount: Field,
    in1_blinding: Field,
    in1_index: Field,
    in1_path: [Field; 32],
    in1_path_indices: [bool; 32],

    // private: input note 2 (set in2_amount = 0 to disable)
    in2_amount: Field,
    in2_blinding: Field,
    in2_index: Field,
    in2_path: [Field; 32],
    in2_path_indices: [bool; 32],

    // private: output note 1 (recipient)
    out1_owner_pk_x: Field,
    out1_owner_pk_y: Field,
    out1_amount: Field,
    out1_blinding: Field,

    // private: output note 2 (change; set out2_amount = 0 to disable)
    out2_owner_pk_x: Field,
    out2_owner_pk_y: Field,
    out2_amount: Field,
    out2_blinding: Field,
) {
    // 1. derive owner public key from spending key
    let owner_pk = derive_public_key(spending_key);

    // 2a. F3: recompute tx_hash from ALL public inputs and bind the signature to
    // it. preimage order MUST match the worker (shieldWorker handleProveTransfer):
    // pool_root, nullifier1, nullifier2, output_commitment1, output_commitment2,
    // asset_id, fee. (the previous build signed only a partial preimage that
    // omitted output_commitment2/asset_id/fee; this closes that gap so the
    // signature provably commits to the whole transfer.)
    let preimage: [Field; 7] = [
        pool_root, nullifier1, nullifier2,
        output_commitment1, output_commitment2, asset_id, fee,
    ];
    let computed_tx_hash = poseidon2::hash(preimage, 7);
    assert(computed_tx_hash == tx_hash, "tx_hash mismatch");

    // 2b. verify spending authorization (schnorr over tx_hash)
    verify_signature(owner_pk.x, owner_pk.y, signature, tx_hash);

    // 3. range-check fee (no negative fees)
    assert_amount_in_range(fee);

    // 4. process input note 1
    assert_amount_positive(in1_amount);
    let in1_note = Note {
        owner_pk_x: owner_pk.x,
        owner_pk_y: owner_pk.y,
        asset_id,
        amount: in1_amount,
        blinding: in1_blinding,
    };
    let in1_commitment = compute_commitment(in1_note);
    verify_merkle_inclusion(in1_commitment, in1_path, in1_path_indices, pool_root);

    // bind the nullifier index to the merkle path position. without this, the
    // index is a free witness and a prover could derive many distinct
    // nullifiers from a single note (double-spend / value inflation).
    assert(in1_index == index_from_path(in1_path_indices), "Input 1 index/path mismatch");

    let computed_null1 = derive_nullifier(spending_key, in1_commitment, in1_index);
    assert(computed_null1 == nullifier1, "Nullifier 1 mismatch");

    // 5. process input note 2 (conditionally - keep circuit shape constant)
    assert_amount_in_range(in2_amount);
    let in2_active = in2_amount != 0;
    let in2_note = Note {
        owner_pk_x: owner_pk.x,
        owner_pk_y: owner_pk.y,
        asset_id,
        amount: in2_amount,
        blinding: in2_blinding,
    };
    let in2_commitment = compute_commitment(in2_note);

    // inclusion: enforce only when active.
    // if inactive, the path can be all zeros and we simply skip the assertion
    // by zeroing the difference.
    let in2_root_check = compute_merkle_root(in2_commitment, in2_path, in2_path_indices);
    if in2_active {
        assert(in2_root_check == pool_root, "Input note 2 not in pool");
        // same index/path binding as input 1 (only enforced when active).
        assert(in2_index == index_from_path(in2_path_indices), "Input 2 index/path mismatch");
    }

    let computed_null2 = derive_nullifier(spending_key, in2_commitment, in2_index);
    if in2_active {
        assert(computed_null2 == nullifier2, "Nullifier 2 mismatch");
        // two active inputs must be distinct notes, hence distinct nullifiers.
        // blocks using the same note as both inputs to double-count value.
        assert(nullifier1 != nullifier2, "Duplicate nullifier");
    } else {
        // when inactive, public input must be zero (caller convention)
        assert(nullifier2 == 0, "Nullifier 2 must be zero when in2 inactive");
    }

    // 6. process output 1 (recipient - required). F2: anti-dust floor.
    assert_output_value(out1_amount);
    assert(out1_amount != 0, "Output 1 must be positive");
    let out1_note = Note {
        owner_pk_x: out1_owner_pk_x,
        owner_pk_y: out1_owner_pk_y,
        asset_id,
        amount: out1_amount,
        blinding: out1_blinding,
    };
    let computed_out1 = compute_commitment(out1_note);
    assert(computed_out1 == output_commitment1, "Output commitment 1 mismatch");

    // 7. process output 2 (change - optional). F2: 0 (decoy) or >= min.
    assert_output_value(out2_amount);
    let out2_active = out2_amount != 0;
    let out2_note = Note {
        owner_pk_x: out2_owner_pk_x,
        owner_pk_y: out2_owner_pk_y,
        asset_id,
        amount: out2_amount,
        blinding: out2_blinding,
    };
    let computed_out2 = compute_commitment(out2_note);
    if out2_active {
        assert(computed_out2 == output_commitment2, "Output commitment 2 mismatch");
    } else {
        assert(output_commitment2 == 0, "Output commitment 2 must be zero when inactive");
    }

    // 8. value balance: in1 + in2 == out1 + out2 + fee
    // all operands are bounded by u128, so sum fits in field with no overflow.
    let total_in: Field = in1_amount + in2_amount;
    let total_out: Field = out1_amount + out2_amount + fee;
    assert(total_in == total_out, "Value balance violated");
}
