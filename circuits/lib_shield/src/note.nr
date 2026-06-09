// note.nr
// note commitment scheme.
// a note is (owner_pk_x, owner_pk_y, asset_id, amount, blinding).
// commitment c = poseidon2(owner_pk_x, owner_pk_y, asset_id, amount, blinding).
// asset id = poseidon2(contract_address, chain_id).

use crate::poseidon2;

pub struct Note {
    pub owner_pk_x: Field,
    pub owner_pk_y: Field,
    pub asset_id:   Field,
    pub amount:     Field,
    pub blinding:   Field,
}

/// c = poseidon2(pk_x, pk_y, asset_id, amount, blinding)
pub fn compute_commitment(note: Note) -> Field {
    poseidon2::hash(
        [note.owner_pk_x, note.owner_pk_y, note.asset_id, note.amount, note.blinding],
        5,
    )
}

/// anti-dust floor (F2): a real (non-zero) output note must be worth at least
/// this many base units. decoy/change outputs of exactly 0 are still allowed
/// (the protocol intentionally creates zero-value decoys for shape uniformity).
/// 1000 = 0.0001 units at 7 decimals -- below any realistic payment, so it never
/// breaks legitimate flows, but stops sub-dust spendable notes from being minted.
global MIN_NOTE_VALUE: u128 = 1000;

/// range-check amount fits in u128 (prevents overflow attacks).
pub fn assert_amount_in_range(amount: Field) {
    let amount_u128 = amount as u128;
    assert(amount_u128 as Field == amount, "Amount overflows u128");
}

/// strict positive (for non-zero notes).
pub fn assert_amount_positive(amount: Field) {
    assert_amount_in_range(amount);
    assert(amount != 0, "Amount must be positive");
}

/// output value rule (F2): a note that gets appended to the tree must be either
/// a zero-value decoy or worth at least MIN_NOTE_VALUE. range-checked first.
pub fn assert_output_value(amount: Field) {
    let amt = amount as u128;
    assert(amt as Field == amount, "Amount overflows u128");
    assert((amt == 0) | (amt >= MIN_NOTE_VALUE), "Output below minimum note value");
}

/// asset_id = poseidon2(contract_address, chain_id)
pub fn compute_asset_id(contract_address: Field, chain_id: Field) -> Field {
    poseidon2::hash([contract_address, chain_id], 2)
}
