use lib_shield::note::{Note, compute_commitment};

fn main(
    owner_pk_x: Field,
    owner_pk_y: Field,
    asset_id: Field,
    amount: Field,
    blinding: Field,
) -> pub Field {
    let note = Note {
        owner_pk_x,
        owner_pk_y,
        asset_id,
        amount,
        blinding,
    };
    compute_commitment(note)
}
