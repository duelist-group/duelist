// babyjubjub.nr
// grumpkin key derivation, nullifiers, schnorr verification.
// embedded curve for bn254/barretenberg is grumpkin.

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};
use crate::poseidon2;
use crate::schnorr;

global VIEWING_KEY_DOMAIN: Field = 1;
global NULLIFIER_DOMAIN: Field   = 2;

/// derive the grumpkin public key: pk = sk * g
pub fn derive_public_key(spending_key: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(spending_key))
}

/// derive viewing key from spending key: vk = poseidon2(sk, domain=1)
pub fn derive_viewing_key(spending_key: Field) -> Field {
    poseidon2::hash([spending_key, VIEWING_KEY_DOMAIN], 2)
}

/// derive viewing public key: vpk = vk * g
pub fn derive_viewing_pk(viewing_key: Field) -> EmbeddedCurvePoint {
    fixed_base_scalar_mul(EmbeddedCurveScalar::from_field(viewing_key))
}

/// nullifier = poseidon2(spending_key, commitment, leaf_index, domain=2)
pub fn derive_nullifier(
    spending_key: Field,
    commitment: Field,
    leaf_index: Field,
) -> Field {
    poseidon2::hash([spending_key, commitment, leaf_index, NULLIFIER_DOMAIN], 4)
}

/// verify a schnorr signature over a message hash.
/// signature: [u8; 64] -- s(32 le) || e(32 le)
/// message_hash: tx_hash field, converted to 32 bytes be
pub fn verify_signature(
    public_key_x: Field,
    public_key_y: Field,
    signature: [u8; 64],
    message_hash: Field,
) {
    let msg_bytes: [u8; 32] = message_hash.to_be_bytes();
    let pub_key = EmbeddedCurvePoint { x: public_key_x, y: public_key_y, is_infinite: false };
    let valid = schnorr::verify_signature(pub_key, signature, msg_bytes);
    assert(valid, "Schnorr signature invalid");
}
