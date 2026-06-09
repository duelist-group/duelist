// contracts/engine/engine/src/lib.rs
// shield protocol — native ultrahonk verifier engine (protocol 26 / cap-80)
// one wasm, deployed 3 times (deposit / transfer / withdraw) with different vks.
// each instance stores its vk in instance storage on initialize(), then the
// verifier dispatcher calls verify_proof() to run the native bn254 ultrahonk
// verifier using soroban host functions (~200m cpu instructions, dropping further
// as the host function implementation is optimised).
// interface matches what contracts/verifier/src/lib.rs expects:
// fn verify_proof(proof: bytes, public_inputs: vec<bytesn<32>>) -> bool

#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Bytes, BytesN, Env, Vec};
use ultrahonk_soroban_verifier::UltraHonkVerifier;

const VK_KEY: soroban_sdk::Symbol = symbol_short!("vk");

#[contract]
pub struct Engine;

#[contractimpl]
impl Engine {
    /// store the circuits verification key. call exactly once after deployment.
    /// vk_bytes: raw vk file contents (1760 bytes for current ultrahonk circuits).
    pub fn initialize(env: Env, vk_bytes: Bytes) {
        if env.storage().instance().has(&VK_KEY) {
            panic!("already initialized");
        }
        env.storage().instance().set(&VK_KEY, &vk_bytes);
    }

    /// called by the verifier dispatcher for each proof.
    /// flattens vec<bytesn<32>> into a contiguous bytes buffer (32 bytes per element,
    /// big-endian) and forwards to ultrahonkverifier::verify.
    pub fn verify_proof(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&VK_KEY)
            .expect("not initialized — call initialize() first");

        // flatten vec<bytesn<32>> → bytes (each element is 32 bytes big-endian).
        let mut pi = Bytes::new(&env);
        for elem in public_inputs.iter() {
            pi.append(&Bytes::from_array(&env, &elem.to_array()));
        }

        match UltraHonkVerifier::new(&env, &vk) {
            Ok(verifier) => verifier.verify(&proof, &pi).is_ok(),
            Err(_) => false,
        }
    }

    /// returns whether this engine has been initialized with a vk.
    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().has(&VK_KEY)
    }
}
