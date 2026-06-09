// withdraw/src/main.nr
// shielded -> public ramp-off circuit.
// railgun model: no poi in the circuit. the pool itself is the trust boundary
// (deposit gate already screened sources). at withdrawal we only verify:
// 1. input ownership - prover holds the spending key
// 2. input existence - note is in the pool tree
// 3. nullifier validity - nullifier correctly derived
// 4. amount binding - withdraw_amount + fee == note_amount
// 5. recipient binding - proof commits to recipient_stellar_hash so a
// malicious relayer cannot redirect the funds
// 6. sig authorization - schnorr signature over tx_hash
// (optional: a separate "compliance proof" circuit can be generated off-band
// by users who want to prove poi to a regulator. lives in the sdk, not here.)
// public inputs:
// pool_root, nullifier, asset_id,
// withdraw_amount, fee, recipient_stellar_hash, tx_hash

use lib_shield::merkle::verify_merkle_inclusion;
use lib_shield::merkle::index_from_path;
use lib_shield::babyjubjub::{derive_public_key, derive_nullifier, verify_signature};
use lib_shield::note::{Note, compute_commitment, assert_amount_positive, assert_amount_in_range};



fn main(
    pool_root: pub Field,
    nullifier: pub Field,
    asset_id: pub Field,
    withdraw_amount: pub Field,
    fee: pub Field,
    recipient_stellar_hash: pub Field,
    tx_hash: pub Field,

    spending_key: Field,
    signature: [u8; 64],

    note_amount: Field,
    note_blinding: Field,
    note_index: Field,
    note_path: [Field; 32],
    note_path_indices: [bool; 32],

    // recipient stellar address packed into a field (32 bytes -> 1 field).
    recipient_address_field: Field,
) {
    let owner_pk = derive_public_key(spending_key);
    verify_signature(owner_pk.x, owner_pk.y, signature, tx_hash);

    assert_amount_positive(note_amount);
    assert_amount_in_range(withdraw_amount);
    assert_amount_in_range(fee);

    let note = Note {
        owner_pk_x: owner_pk.x,
        owner_pk_y: owner_pk.y,
        asset_id,
        amount: note_amount,
        blinding: note_blinding,
    };
    let commitment = compute_commitment(note);
    verify_merkle_inclusion(commitment, note_path, note_path_indices, pool_root);

    // bind the nullifier index to the merkle path position. without this, the
    // index is a free witness and the same note could be withdrawn repeatedly,
    // each time producing a fresh nullifier the contract would accept.
    assert(note_index == index_from_path(note_path_indices), "Note index/path mismatch");

    let computed_null = derive_nullifier(spending_key, commitment, note_index);
    assert(computed_null == nullifier, "Nullifier mismatch");

    // amount binding: full withdrawal of the note (no partials in v1).
    assert(note_amount == withdraw_amount + fee, "Amount mismatch");

    // recipient binding: prover commits to a specific recipient. the soroban
    // contract receives the address in the clear and re-hashes it; if the hash
    // doesnt match recipient_stellar_hash, the contract rejects.
    // to keep the circuit minimal and avoid poseidon2 length-1 ambiguity, the
    // sdk and contract both compute sha-256(addr.to_xdr()) reduced mod the
    // field prime, so the value used inside the proof is the public input.
    // we therefore simply assert equality.
    assert(recipient_address_field == recipient_stellar_hash, "Recipient mismatch");
}
