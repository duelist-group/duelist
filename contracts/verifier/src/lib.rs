// contracts/verifier/src/lib.rs
// shield protocol — ultrahonk verifier dispatcher (v3)
// stores five engine addresses — one per circuit:
// deposit, transfer (single 2-in/2-out), transfer_batch (16-in/12-out),
// withdraw_small (4-in), withdraw_large (16-in).
// each engine is a deployed instance of indextree/ultrahonk_soroban_contract,
// which bakes its vk in at deploy time and exposes:
// fn verify_proof(proof: bytes, public_inputs: vec<bytesn<32>>) -> bool
// the pool contract calls verify_deposit / verify_transfer / verify_transfer_batch
// / verify_withdraw_small / verify_withdraw_large. the dispatcher is
// public-input-count agnostic — it just forwards the vec; the vk encodes the count.
// to upgrade an engine (e.g. after a circuit change or barretenberg bump):
// deploy a new engine instance with the new vk, then call the matching
// set_*_engine. pool never moves.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

#[contracttype]
pub enum DataKey {
    Admin,
    EngineDeposit,
    EngineTransfer,
    EngineTransferBatch,
    EngineWithdrawSmall,
    EngineWithdrawLarge,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    EngineNotSet = 4,
}

fn verify_proof_sym(env: &Env) -> Symbol {
    Symbol::new(env, "verify_proof")
}

#[contract]
pub struct Verifier;

#[contractimpl]
impl Verifier {
    /// one-shot init. pass the five engine contract addresses — one per circuit.
    pub fn initialize(
        env: Env,
        admin: Address,
        engine_deposit: Address,
        engine_transfer: Address,
        engine_transfer_batch: Address,
        engine_withdraw_small: Address,
        engine_withdraw_large: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, VerifierError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::EngineDeposit, &engine_deposit);
        env.storage().instance().set(&DataKey::EngineTransfer, &engine_transfer);
        env.storage().instance().set(&DataKey::EngineTransferBatch, &engine_transfer_batch);
        env.storage().instance().set(&DataKey::EngineWithdrawSmall, &engine_withdraw_small);
        env.storage().instance().set(&DataKey::EngineWithdrawLarge, &engine_withdraw_large);
        env.events().publish((symbol_short!("init"),), (admin,));
    }

    // admin: rotate individual engines

    pub fn set_deposit_engine(env: Env, new_engine: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::EngineDeposit, &new_engine);
        env.events().publish((symbol_short!("dep_eng"),), new_engine);
    }

    pub fn set_transfer_engine(env: Env, new_engine: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::EngineTransfer, &new_engine);
        env.events().publish((symbol_short!("xfr_eng"),), new_engine);
    }

    pub fn set_transfer_batch_engine(env: Env, new_engine: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::EngineTransferBatch, &new_engine);
        env.events().publish((symbol_short!("xfrb_eng"),), new_engine);
    }

    pub fn set_withdraw_small_engine(env: Env, new_engine: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::EngineWithdrawSmall, &new_engine);
        env.events().publish((symbol_short!("wdws_eng"),), new_engine);
    }

    pub fn set_withdraw_large_engine(env: Env, new_engine: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::EngineWithdrawLarge, &new_engine);
        env.events().publish((symbol_short!("wdwl_eng"),), new_engine);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish((symbol_short!("admin"),), new_admin);
    }

    // verification entry points (called by the pool)

    pub fn verify_deposit(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        Self::dispatch(&env, DataKey::EngineDeposit, proof, public_inputs)
    }

    pub fn verify_transfer(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        Self::dispatch(&env, DataKey::EngineTransfer, proof, public_inputs)
    }

    pub fn verify_transfer_batch(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        Self::dispatch(&env, DataKey::EngineTransferBatch, proof, public_inputs)
    }

    pub fn verify_withdraw_small(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        Self::dispatch(&env, DataKey::EngineWithdrawSmall, proof, public_inputs)
    }

    pub fn verify_withdraw_large(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool {
        Self::dispatch(&env, DataKey::EngineWithdrawLarge, proof, public_inputs)
    }

    fn dispatch(
        env: &Env,
        engine_key: DataKey,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        let engine: Address = env
            .storage()
            .instance()
            .get(&engine_key)
            .unwrap_or_else(|| panic_with_error!(env, VerifierError::EngineNotSet));

        env.invoke_contract(
            &engine,
            &verify_proof_sym(env),
            (proof, public_inputs).into_val(env),
        )
    }

    // helpers

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, VerifierError::NotInitialized));
        admin.require_auth();
    }

    // getters

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::NotInitialized))
    }

    pub fn engine_deposit(env: Env) -> Address {
        env.storage().instance().get(&DataKey::EngineDeposit)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::EngineNotSet))
    }

    pub fn engine_transfer(env: Env) -> Address {
        env.storage().instance().get(&DataKey::EngineTransfer)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::EngineNotSet))
    }

    pub fn engine_transfer_batch(env: Env) -> Address {
        env.storage().instance().get(&DataKey::EngineTransferBatch)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::EngineNotSet))
    }

    pub fn engine_withdraw_small(env: Env) -> Address {
        env.storage().instance().get(&DataKey::EngineWithdrawSmall)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::EngineNotSet))
    }

    pub fn engine_withdraw_large(env: Env) -> Address {
        env.storage().instance().get(&DataKey::EngineWithdrawLarge)
            .unwrap_or_else(|| panic_with_error!(&env, VerifierError::EngineNotSet))
    }
}
