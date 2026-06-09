// deposit/src/main.nr
// public -> shielded ramp-on circuit.
// in the railgun model, the source-address screening happens off-chain at the
// relayer (ofac api check) before this transaction is admitted. the circuit
// itself only needs to prove that the output commitment is well-formed.
// the soroban contract independently verifies the sac token transfer of the
// declared amount, so the amount in the proof must match the on-chain transfer.
// public inputs (verifier interface order):
// output_commitment, asset_id, amount

use lib_shield::note::{Note, compute_commitment, assert_amount_positive, assert_output_value};

fn main(
    output_commitment: pub Field,
    asset_id: pub Field,
    amount: pub Field,

    // private - recipient identity and blinding factor.
    owner_pk_x: Field,
    owner_pk_y: Field,
    blinding: Field,
) {
    // F2: a deposit mints exactly one output note -> enforce the anti-dust floor.
    // deposit amount is always > 0 (also checked on-chain), so the zero branch of
    // assert_output_value never applies here; assert_amount_positive keeps that
    // explicit for the deposit case.
    assert_amount_positive(amount);
    assert_output_value(amount);

    let note = Note {
        owner_pk_x,
        owner_pk_y,
        asset_id,
        amount,
        blinding,
    };
    let computed = compute_commitment(note);
    assert(computed == output_commitment, "Deposit: commitment mismatch");
}
