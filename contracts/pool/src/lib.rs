// contracts/pool/src/lib.rs
// shield protocol — shielded pool contract (soroban / stellar)
// v2: on-chain incremental poseidon2 merkle tree. the pool_root is updated
// atomically inside deposit() and transfer() — no admin root-update needed.

#![no_std]
#![allow(deprecated)]

mod poseidon2_constants;
use poseidon2_constants::{POSEIDON2_DIAG, POSEIDON2_RC};

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, BytesN, Env, Symbol, Bytes, Vec, IntoVal, symbol_short,
    token, panic_with_error, U256,
};

const ZERO_HASH: [u8; 32] = [0u8; 32];
const TREE_DEPTH: u32 = 32;

// storage ttl constants

const NULLIFIER_TTL_LEDGERS: u32   = 2_592_000;
const NULLIFIER_BUMP_TARGET: u32   = 5_184_000;
const ROOT_TTL_LEDGERS: u32        = 3_000_000;   // ~174 days threshold
const ROOT_BUMP_TARGET: u32        = 5_000_000;   // ~290 days target
const COMMITMENT_TTL_LEDGERS: u32  = 2_592_000;
const COMMITMENT_BUMP_TARGET: u32  = 5_184_000;

const MAX_PROTOCOL_FEE_BPS: u32 = 1000;

// number of recent merkle roots accepted by spend operations. a user proves
// against the root the indexer served them; if other txs advance the root before
// theirs lands, an older-but-recent root is still valid (the tree is append-only,
// so membership and the nullifier set still hold). this is the standard fix for
// the single-root liveness race on a shared pool.
const ROOT_HISTORY_SIZE: u32 = 64;

// events

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositEvent {
    pub commitment: BytesN<32>,
    pub asset_id: BytesN<32>,
    pub amount: i128,
    pub leaf_index: u32,
    pub encrypted_note: Bytes,
    pub ephemeral_pk: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferEvent {
    pub nullifier1: BytesN<32>,
    pub nullifier2: BytesN<32>,
    pub commitment1: BytesN<32>,
    pub commitment2: BytesN<32>,
    pub asset_id: BytesN<32>,
    pub leaf_index1: u32,
    pub leaf_index2: u32,
    pub encrypted_note1: Bytes,
    pub encrypted_note2: Bytes,
    pub ephemeral_pk1: BytesN<64>,
    pub ephemeral_pk2: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawEvent {
    pub nullifiers: Vec<BytesN<32>>,
    pub change_commitment: BytesN<32>,
    pub decoy_commitment: BytesN<32>,
    pub asset_id: BytesN<32>,
    pub amount: i128,
    pub recipient: Address,
    pub change_leaf_index: u32,
    pub decoy_leaf_index: u32,
    pub encrypted_note_change: Bytes,
    pub encrypted_note_decoy: Bytes,
    pub ephemeral_pk_change: BytesN<64>,
    pub ephemeral_pk_decoy: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferBatchEvent {
    pub nullifiers: Vec<BytesN<32>>,
    pub commitments: Vec<BytesN<32>>,
    pub leaf_indices: Vec<u32>,
    pub asset_id: BytesN<32>,
    pub encrypted_notes: Vec<Bytes>,
    pub ephemeral_pks: Vec<BytesN<64>>,
}

// storage keys

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    VerifierContract,
    ComplianceContract,
    PoolRoot,
    BlacklistRoot,
    CommitmentCount,
    Paused,
    ProtocolFeeBps,
    WithdrawFeeBps,   // protocol fee on withdrawals (floor bps, enforced on-chain)
    RelayFeeMin,      // minimum relay fee in token stroops (enforced on-chain)
    FeeRecipient,
    // incremental merkle tree state
    FilledSubtrees,   // Vec<BytesN<32>> — one per tree level (TREE_DEPTH entries)
    Zeros,            // Vec<BytesN<32>> — zero-hash at each level (TREE_DEPTH + 1 entries)
    // bn254 poseidon2 parameters (stored once at initialize, read on every hash)
    Poseidon2Diag,    // Vec<U256> — 4 internal matrix diagonal elements
    Poseidon2RC,      // Vec<Vec<U256>> — 64 rows × 4 round constants
    RootHistory,      // Vec<BytesN<32>> — recent roots accepted by spend ops (liveness)
}

#[contracttype]
pub enum PersistKey {
    Nullifier(BytesN<32>),
    Commitment(u32),
    AssetAllowed(BytesN<32>),
    AssetContract(BytesN<32>),
}

// errors

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    AlreadyInitialized   = 1,
    NotInitialized       = 2,
    Unauthorized         = 3,
    InvalidProof         = 4,
    NullifierSpent       = 5,
    AssetNotAllowed      = 6,
    AmountTooLow         = 7,
    PoolRootMismatch     = 8,
    BlacklistMismatch    = 9,
    Paused              = 10,
    FeeOutOfRange       = 11,
    AmountOverflow      = 12,
    AssetMismatch       = 13,
    RecipientMismatch   = 14,
    InvalidArgument     = 15,
    Sanctioned          = 16,
    FeeTooLow           = 17,
}

// contract

#[contract]
pub struct ShieldedPool;

#[contractimpl]
impl ShieldedPool {
    // initialization
    // `initial_blacklist_root` is kept for interface compatibility. the pool
    // root is now computed on-chain from the empty merkle tree — the
    // `initial_pool_root` argument is removed.
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier_contract: Address,
        compliance_contract: Address,
        fee_recipient: Address,
        protocol_fee_bps: u32,
        initial_blacklist_root: BytesN<32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, PoolError::AlreadyInitialized);
        }
        if protocol_fee_bps > MAX_PROTOCOL_FEE_BPS {
            panic_with_error!(&env, PoolError::FeeOutOfRange);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VerifierContract, &verifier_contract);
        env.storage().instance().set(&DataKey::ComplianceContract, &compliance_contract);
        env.storage().instance().set(&DataKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&DataKey::ProtocolFeeBps, &protocol_fee_bps);
        env.storage().instance().set(&DataKey::BlacklistRoot, &initial_blacklist_root);
        env.storage().instance().set(&DataKey::CommitmentCount, &0u32);
        env.storage().instance().set(&DataKey::Paused, &false);

        // store bn254 poseidon2 t=4 parameters (done once; read on every hash).
        let mut diag: Vec<U256> = Vec::new(&env);
        for d in POSEIDON2_DIAG.iter() {
            let bytes = Bytes::from_array(&env, d);
            diag.push_back(U256::from_be_bytes(&env, &bytes));
        }
        env.storage().instance().set(&DataKey::Poseidon2Diag, &diag);

        let mut rc: Vec<Vec<U256>> = Vec::new(&env);
        for row in POSEIDON2_RC.iter() {
            let mut row_vec: Vec<U256> = Vec::new(&env);
            for elem in row.iter() {
                let bytes = Bytes::from_array(&env, elem);
                row_vec.push_back(U256::from_be_bytes(&env, &bytes));
            }
            rc.push_back(row_vec);
        }
        env.storage().instance().set(&DataKey::Poseidon2RC, &rc);

        // build zero-hash table for all levels and initialize filled subtrees.
        // zeros[i] = poseidon2(zeros[i-1], zeros[i-1])
        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let mut h = BytesN::<32>::from_array(&env, &ZERO_HASH);
        zeros.push_back(h.clone());
        for _ in 0..TREE_DEPTH {
            h = Self::poseidon2_hash(&env, &h, &h);
            zeros.push_back(h.clone());
        }
        env.storage().instance().set(&DataKey::Zeros, &zeros);

        // filled subtrees start as all-zeros (empty tree).
        let mut filled: Vec<BytesN<32>> = Vec::new(&env);
        for i in 0..TREE_DEPTH {
            filled.push_back(zeros.get(i).unwrap());
        }
        env.storage().instance().set(&DataKey::FilledSubtrees, &filled);

        // the root of an empty tree of depth tree_depth.
        let empty_root: BytesN<32> = zeros.get(TREE_DEPTH).unwrap();
        env.storage().instance().set(&DataKey::PoolRoot, &empty_root);
        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);

        env.events().publish(
            (symbol_short!("init"), admin),
            (verifier_contract, compliance_contract),
        );
    }

    // admin: register an asset and its sac contract address
    pub fn register_asset(
        env: Env,
        caller: Address,
        asset_id: BytesN<32>,
        asset_contract: Address,
        allowed: bool,
    ) {
        caller.require_auth();
        Self::require_admin(&env, &caller);

        env.storage().persistent().set(&PersistKey::AssetAllowed(asset_id.clone()), &allowed);
        env.storage().persistent().set(&PersistKey::AssetContract(asset_id.clone()), &asset_contract);
        env.storage().persistent().extend_ttl(
            &PersistKey::AssetAllowed(asset_id.clone()),
            COMMITMENT_TTL_LEDGERS,
            COMMITMENT_BUMP_TARGET,
        );
        env.storage().persistent().extend_ttl(
            &PersistKey::AssetContract(asset_id.clone()),
            COMMITMENT_TTL_LEDGERS,
            COMMITMENT_BUMP_TARGET,
        );

        env.events().publish((symbol_short!("asset_set"), asset_id), allowed);
    }

    // admin: pause / unpause (emergency lever)
    pub fn set_paused(env: Env, caller: Address, paused: bool) {
        caller.require_auth();
        Self::require_admin(&env, &caller);
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish((symbol_short!("paused"),), paused);
    }

    // admin: update fee parameters
    // protocol_fee_bps — deposit protocol fee (floor division, max 1000 = 10%)
    // withdraw_fee_bps — withdraw protocol fee (floor division, max 1000 = 10%)
    // relay_fee_min — minimum relay fee in token stroops enforced on-chain
    pub fn set_fee_bps(
        env: Env,
        caller: Address,
        protocol_fee_bps: u32,
        withdraw_fee_bps: u32,
        relay_fee_min: i128,
    ) {
        caller.require_auth();
        Self::require_admin(&env, &caller);
        if protocol_fee_bps > MAX_PROTOCOL_FEE_BPS {
            panic_with_error!(&env, PoolError::FeeOutOfRange);
        }
        if withdraw_fee_bps > MAX_PROTOCOL_FEE_BPS {
            panic_with_error!(&env, PoolError::FeeOutOfRange);
        }
        if relay_fee_min < 0 {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }
        env.storage().instance().set(&DataKey::ProtocolFeeBps, &protocol_fee_bps);
        env.storage().instance().set(&DataKey::WithdrawFeeBps, &withdraw_fee_bps);
        env.storage().instance().set(&DataKey::RelayFeeMin, &relay_fee_min);
        env.events().publish(
            (symbol_short!("fees"),),
            (protocol_fee_bps, withdraw_fee_bps, relay_fee_min),
        );
    }

    // admin: two-step admin handover
    pub fn propose_admin(env: Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        Self::require_admin(&env, &caller);
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
    }

    pub fn accept_admin(env: Env, caller: Address) {
        caller.require_auth();
        let pending: Address = env.storage().instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::Unauthorized));
        if caller != pending {
            panic_with_error!(&env, PoolError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish((symbol_short!("new_admin"),), pending);
    }

    // compliance: update blacklist root
    pub fn update_blacklist_root(env: Env, caller: Address, new_root: BytesN<32>) {
        caller.require_auth();
        let compliance: Address = env.storage().instance()
            .get(&DataKey::ComplianceContract)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));
        if caller != compliance {
            panic_with_error!(&env, PoolError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::BlacklistRoot, &new_root);
        env.events().publish((symbol_short!("bl_root"),), new_root);
    }

    // deposit (public → shielded)
    pub fn deposit(
        env: Env,
        depositor: Address,
        asset_id: BytesN<32>,
        amount: i128,
        output_commitment: BytesN<32>,
        proof: Bytes,
        encrypted_note: Bytes,
        ephemeral_pk: BytesN<64>,
    ) {
        depositor.require_auth();
        Self::require_not_paused(&env);

        let compliance: Address = env.storage().instance()
            .get(&DataKey::ComplianceContract)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));
        let clean: bool = env.invoke_contract(
            &compliance,
            &Symbol::new(&env, "is_clean"),
            (depositor.clone(),).into_val(&env),
        );
        if !clean {
            panic_with_error!(&env, PoolError::Sanctioned);
        }

        if amount <= 0 {
            panic_with_error!(&env, PoolError::AmountTooLow);
        }

        let allowed: bool = env.storage().persistent()
            .get(&PersistKey::AssetAllowed(asset_id.clone()))
            .unwrap_or(false);
        if !allowed {
            panic_with_error!(&env, PoolError::AssetNotAllowed);
        }

        let asset_contract: Address = env.storage().persistent()
            .get(&PersistKey::AssetContract(asset_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::AssetNotAllowed));

        let fee_bps: u32 = env.storage().instance().get(&DataKey::ProtocolFeeBps).unwrap_or(0);
        let fee_amount: i128 = (amount as i128)
            .checked_mul(fee_bps as i128)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::AmountOverflow))
            / 10_000;
        let net_amount: i128 = amount.checked_sub(fee_amount)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::AmountOverflow));
        if net_amount <= 0 {
            panic_with_error!(&env, PoolError::AmountTooLow);
        }

        let verifier: Address = env.storage().instance()
            .get(&DataKey::VerifierContract)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));

        let mut public_inputs: Vec<BytesN<32>> = Vec::new(&env);
        public_inputs.push_back(output_commitment.clone());
        public_inputs.push_back(asset_id.clone());
        public_inputs.push_back(Self::i128_to_hash32(&env, net_amount));

        let proof_valid: bool = env.invoke_contract(
            &verifier,
            &Symbol::new(&env, "verify_deposit"),
            (proof.clone(), public_inputs).into_val(&env),
        );
        if !proof_valid {
            panic_with_error!(&env, PoolError::InvalidProof);
        }

        let token_client = token::Client::new(&env, &asset_contract);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        if fee_amount > 0 {
            let fee_recipient: Address = env.storage().instance()
                .get(&DataKey::FeeRecipient)
                .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));
            token_client.transfer(&env.current_contract_address(), &fee_recipient, &fee_amount);
        }

        let leaf_index = Self::append_commitment_and_update_root(&env, output_commitment.clone());

        env.events().publish(
            (symbol_short!("deposit"),),
            DepositEvent {
                commitment: output_commitment,
                asset_id,
                amount: net_amount,
                leaf_index,
                encrypted_note,
                ephemeral_pk,
            },
        );
    }

    // shielded transfer
    pub fn transfer(
        env: Env,
        relayer: Address,
        proof: Bytes,
        pool_root: BytesN<32>,
        nullifier1: BytesN<32>,
        nullifier2: BytesN<32>,
        output_commitment1: BytesN<32>,
        output_commitment2: BytesN<32>,
        asset_id: BytesN<32>,
        fee: i128,
        tx_hash: BytesN<32>,
        encrypted_note1: Bytes,
        encrypted_note2: Bytes,
        ephemeral_pk1: BytesN<64>,
        ephemeral_pk2: BytesN<64>,
    ) {
        relayer.require_auth();
        Self::require_not_paused(&env);

        if fee < 0 {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }

        // accept the current root or any recent historical root (liveness under
        // concurrent spends); the tree is append-only so membership still holds.
        if !Self::is_known_root(&env, &pool_root) {
            panic_with_error!(&env, PoolError::PoolRootMismatch);
        }

        let allowed: bool = env.storage().persistent()
            .get(&PersistKey::AssetAllowed(asset_id.clone()))
            .unwrap_or(false);
        if !allowed {
            panic_with_error!(&env, PoolError::AssetNotAllowed);
        }

        Self::assert_nullifier_unspent(&env, &nullifier1);

        let zero = BytesN::<32>::from_array(&env, &ZERO_HASH);
        let null2_active = nullifier2 != zero;
        if null2_active {
            Self::assert_nullifier_unspent(&env, &nullifier2);
        }

        let verifier: Address = env.storage().instance()
            .get(&DataKey::VerifierContract)
            .unwrap();

        let mut public_inputs: Vec<BytesN<32>> = Vec::new(&env);
        public_inputs.push_back(pool_root);
        public_inputs.push_back(nullifier1.clone());
        public_inputs.push_back(nullifier2.clone());
        public_inputs.push_back(output_commitment1.clone());
        public_inputs.push_back(output_commitment2.clone());
        public_inputs.push_back(asset_id.clone());
        public_inputs.push_back(Self::i128_to_hash32(&env, fee));
        public_inputs.push_back(tx_hash);

        let proof_valid: bool = env.invoke_contract(
            &verifier,
            &Symbol::new(&env, "verify_transfer"),
            (proof, public_inputs).into_val(&env),
        );
        if !proof_valid {
            panic_with_error!(&env, PoolError::InvalidProof);
        }

        Self::mark_nullifier_spent(&env, &nullifier1);
        if null2_active {
            Self::mark_nullifier_spent(&env, &nullifier2);
        }

        let leaf_index1 = Self::append_commitment_and_update_root(&env, output_commitment1.clone());
        let zero_commit = BytesN::<32>::from_array(&env, &ZERO_HASH);
        let leaf_index2 = if output_commitment2 != zero_commit {
            Self::append_commitment_and_update_root(&env, output_commitment2.clone())
        } else {
            u32::MAX
        };

        if fee > 0 {
            let asset_contract: Address = env.storage().persistent()
                .get(&PersistKey::AssetContract(asset_id.clone()))
                .unwrap_or_else(|| panic_with_error!(&env, PoolError::AssetNotAllowed));
            let fee_recipient: Address = env.storage().instance()
                .get(&DataKey::FeeRecipient)
                .unwrap();
            let token_client = token::Client::new(&env, &asset_contract);
            token_client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
        }

        env.events().publish(
            (symbol_short!("transfer"),),
            TransferEvent {
                nullifier1,
                nullifier2,
                commitment1: output_commitment1,
                commitment2: output_commitment2,
                asset_id,
                leaf_index1,
                leaf_index2,
                encrypted_note1,
                encrypted_note2,
                ephemeral_pk1,
                ephemeral_pk2,
            },
        );
    }

    // withdraw (shielded → public)
    pub fn withdraw(
        env: Env,
        relayer: Address,
        proof: Bytes,
        pool_root: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,        // 4 (small bucket) or 16 (large bucket)
        change_commitment: BytesN<32>,
        decoy_commitment: BytesN<32>,
        asset_id: BytesN<32>,
        withdraw_amount: i128,
        fee: i128,
        recipient: Address,
        recipient_stellar_hash: BytesN<32>,
        tx_hash: BytesN<32>,
        encrypted_note_change: Bytes,
        encrypted_note_decoy: Bytes,
        ephemeral_pk_change: BytesN<64>,
        ephemeral_pk_decoy: BytesN<64>,
    ) {
        relayer.require_auth();
        Self::require_not_paused(&env);

        if withdraw_amount <= 0 || fee < 0 {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }

        // input bucket selects the verifier engine.
        let n = nullifiers.len();
        if n != 4 && n != 16 {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }

        // accept the current root or any recent historical root (liveness under
        // concurrent spends); the tree is append-only so membership still holds.
        if !Self::is_known_root(&env, &pool_root) {
            panic_with_error!(&env, PoolError::PoolRootMismatch);
        }

        let allowed: bool = env.storage().persistent()
            .get(&PersistKey::AssetAllowed(asset_id.clone()))
            .unwrap_or(false);
        if !allowed {
            panic_with_error!(&env, PoolError::AssetNotAllowed);
        }

        // every nullifier must be unspent and pairwise-distinct (circuit also enforces distinctness).
        Self::assert_nullifiers_unspent_distinct(&env, &nullifiers);

        let computed_recipient_hash = Self::hash_address(&env, &recipient);
        if computed_recipient_hash != recipient_stellar_hash {
            panic_with_error!(&env, PoolError::RecipientMismatch);
        }

        let compliance: Address = env.storage().instance()
            .get(&DataKey::ComplianceContract)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));
        let clean: bool = env.invoke_contract(
            &compliance,
            &Symbol::new(&env, "is_clean"),
            (recipient.clone(),).into_val(&env),
        );
        if !clean {
            panic_with_error!(&env, PoolError::Sanctioned);
        }

        // enforce minimum fee on-chain: relay_fee_min + floor(withdraw_amount * withdraw_fee_bps / 10000).
        let withdraw_fee_bps: u32 = env.storage().instance()
            .get(&DataKey::WithdrawFeeBps).unwrap_or(0);
        let relay_fee_min: i128 = env.storage().instance()
            .get(&DataKey::RelayFeeMin).unwrap_or(0);
        let protocol_fee: i128 = withdraw_amount
            .checked_mul(withdraw_fee_bps as i128)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::AmountOverflow))
            / 10_000;
        let min_fee: i128 = relay_fee_min
            .checked_add(protocol_fee)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::AmountOverflow));
        if fee < min_fee {
            panic_with_error!(&env, PoolError::FeeTooLow);
        }

        // public inputs in the circuits exact order:
        // pool_root, nullifier_1..n, change_commitment, decoy_commitment,
        // asset_id, withdraw_amount, fee, recipient_stellar_hash, tx_hash
        let mut public_inputs: Vec<BytesN<32>> = Vec::new(&env);
        public_inputs.push_back(pool_root);
        for i in 0..n {
            public_inputs.push_back(nullifiers.get(i).unwrap());
        }
        public_inputs.push_back(change_commitment.clone());
        public_inputs.push_back(decoy_commitment.clone());
        public_inputs.push_back(asset_id.clone());
        public_inputs.push_back(Self::i128_to_hash32(&env, withdraw_amount));
        public_inputs.push_back(Self::i128_to_hash32(&env, fee));
        public_inputs.push_back(recipient_stellar_hash);
        public_inputs.push_back(tx_hash);

        let verifier: Address = env.storage().instance()
            .get(&DataKey::VerifierContract)
            .unwrap();
        let method = if n == 4 {
            Symbol::new(&env, "verify_withdraw_small")
        } else {
            Symbol::new(&env, "verify_withdraw_large")
        };
        let proof_valid: bool = env.invoke_contract(
            &verifier, &method, (proof, public_inputs).into_val(&env),
        );
        if !proof_valid {
            panic_with_error!(&env, PoolError::InvalidProof);
        }

        // burn every input nullifier.
        for i in 0..n {
            Self::mark_nullifier_spent(&env, &nullifiers.get(i).unwrap());
        }

        // append change + decoy outputs (always both, for on-chain shape uniformity).
        let change_leaf_index = Self::append_commitment_and_update_root(&env, change_commitment.clone());
        let decoy_leaf_index = Self::append_commitment_and_update_root(&env, decoy_commitment.clone());

        let asset_contract: Address = env.storage().persistent()
            .get(&PersistKey::AssetContract(asset_id.clone()))
            .unwrap();
        let token_client = token::Client::new(&env, &asset_contract);
        token_client.transfer(&env.current_contract_address(), &recipient, &withdraw_amount);
        if fee > 0 {
            let fee_recipient: Address = env.storage().instance()
                .get(&DataKey::FeeRecipient)
                .unwrap();
            token_client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
        }

        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);

        env.events().publish(
            (symbol_short!("withdraw"),),
            WithdrawEvent {
                nullifiers,
                change_commitment,
                decoy_commitment,
                asset_id,
                amount: withdraw_amount,
                recipient,
                change_leaf_index,
                decoy_leaf_index,
                encrypted_note_change,
                encrypted_note_decoy,
                ephemeral_pk_change,
                ephemeral_pk_decoy,
            },
        );
    }

    // batch transfer (shielded → shielded, many recipients in one tx)
    // 16 inputs / 12 outputs. outputs include real recipients, the change note,
    // and zero-value decoys (all appended) so the recipient count stays hidden.
    pub fn transfer_batch(
        env: Env,
        relayer: Address,
        proof: Bytes,
        pool_root: BytesN<32>,
        nullifiers: Vec<BytesN<32>>,        // 16
        out_commitments: Vec<BytesN<32>>,   // 12
        asset_id: BytesN<32>,
        fee: i128,
        tx_hash: BytesN<32>,
        encrypted_notes: Vec<Bytes>,        // 12
        ephemeral_pks: Vec<BytesN<64>>,     // 12
    ) {
        relayer.require_auth();
        Self::require_not_paused(&env);

        if fee < 0 {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }
        if nullifiers.len() != 16
            || out_commitments.len() != 12
            || encrypted_notes.len() != 12
            || ephemeral_pks.len() != 12
        {
            panic_with_error!(&env, PoolError::InvalidArgument);
        }

        // accept the current root or any recent historical root (liveness under
        // concurrent spends); the tree is append-only so membership still holds.
        if !Self::is_known_root(&env, &pool_root) {
            panic_with_error!(&env, PoolError::PoolRootMismatch);
        }

        let allowed: bool = env.storage().persistent()
            .get(&PersistKey::AssetAllowed(asset_id.clone()))
            .unwrap_or(false);
        if !allowed {
            panic_with_error!(&env, PoolError::AssetNotAllowed);
        }

        Self::assert_nullifiers_unspent_distinct(&env, &nullifiers);

        // public inputs: pool_root, nullifier_1..16, out_commitment_1..12, asset_id, fee, tx_hash
        let mut public_inputs: Vec<BytesN<32>> = Vec::new(&env);
        public_inputs.push_back(pool_root);
        for i in 0..nullifiers.len() {
            public_inputs.push_back(nullifiers.get(i).unwrap());
        }
        for i in 0..out_commitments.len() {
            public_inputs.push_back(out_commitments.get(i).unwrap());
        }
        public_inputs.push_back(asset_id.clone());
        public_inputs.push_back(Self::i128_to_hash32(&env, fee));
        public_inputs.push_back(tx_hash);

        let verifier: Address = env.storage().instance()
            .get(&DataKey::VerifierContract)
            .unwrap();
        let proof_valid: bool = env.invoke_contract(
            &verifier,
            &Symbol::new(&env, "verify_transfer_batch"),
            (proof, public_inputs).into_val(&env),
        );
        if !proof_valid {
            panic_with_error!(&env, PoolError::InvalidProof);
        }

        for i in 0..nullifiers.len() {
            Self::mark_nullifier_spent(&env, &nullifiers.get(i).unwrap());
        }

        // append all 12 output commitments in one batch — poseidon2 params + tree
        // state are loaded once for the whole set (decoys included, for shape uniformity).
        let leaf_indices: Vec<u32> = Self::append_commitments_batch(&env, &out_commitments);

        if fee > 0 {
            let asset_contract: Address = env.storage().persistent()
                .get(&PersistKey::AssetContract(asset_id.clone()))
                .unwrap_or_else(|| panic_with_error!(&env, PoolError::AssetNotAllowed));
            let fee_recipient: Address = env.storage().instance()
                .get(&DataKey::FeeRecipient)
                .unwrap();
            let token_client = token::Client::new(&env, &asset_contract);
            token_client.transfer(&env.current_contract_address(), &fee_recipient, &fee);
        }

        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);

        env.events().publish(
            (symbol_short!("xfr_batch"),),
            TransferBatchEvent {
                nullifiers,
                commitments: out_commitments,
                leaf_indices,
                asset_id,
                encrypted_notes,
                ephemeral_pks,
            },
        );
    }

    // admin: emergency pool root override (safety valve)
    // kept for disaster recovery. a wrong root submitted here causes proof
    // failures (liveness failure) but cannot steal funds — withdrawals require
    // a merkle inclusion proof against the stored root.
    pub fn submit_new_pool_root(env: Env, caller: Address, new_root: BytesN<32>) {
        caller.require_auth();
        Self::require_admin(&env, &caller);
        env.storage().instance().set(&DataKey::PoolRoot, &new_root);
        Self::push_root(&env, &new_root);
        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);
        env.events().publish((symbol_short!("new_root"),), new_root);
    }

    // admin: contract upgrade (preserves storage)
    // lets future circuit/logic changes upgrade the pool in place without losing
    // the commitment tree / nullifier set. `new_wasm_hash` is the hash of the
    // already-installed new wasm.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::require_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // views
    pub fn pool_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::PoolRoot).unwrap()
    }
    pub fn blacklist_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::BlacklistRoot).unwrap()
    }
    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&PersistKey::Nullifier(nullifier))
    }
    pub fn commitment_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::CommitmentCount).unwrap_or(0)
    }
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    // internal helpers

    fn require_admin(env: &Env, caller: &Address) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, PoolError::NotInitialized));
        if *caller != admin {
            panic_with_error!(env, PoolError::Unauthorized);
        }
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            panic_with_error!(env, PoolError::Paused);
        }
    }

    fn assert_nullifier_unspent(env: &Env, nullifier: &BytesN<32>) {
        if env.storage().persistent().has(&PersistKey::Nullifier(nullifier.clone())) {
            panic_with_error!(env, PoolError::NullifierSpent);
        }
    }

    fn mark_nullifier_spent(env: &Env, nullifier: &BytesN<32>) {
        env.storage().persistent().set(&PersistKey::Nullifier(nullifier.clone()), &true);
        env.storage().persistent().extend_ttl(
            &PersistKey::Nullifier(nullifier.clone()),
            NULLIFIER_TTL_LEDGERS,
            NULLIFIER_BUMP_TARGET,
        );
    }

    /// assert every nullifier in the list is unspent on-chain and that the list
    /// has no duplicates (defense-in-depth; the circuit enforces distinctness too).
    fn assert_nullifiers_unspent_distinct(env: &Env, nullifiers: &Vec<BytesN<32>>) {
        let n = nullifiers.len();
        for i in 0..n {
            let ni = nullifiers.get(i).unwrap();
            Self::assert_nullifier_unspent(env, &ni);
            for j in (i + 1)..n {
                if ni == nullifiers.get(j).unwrap() {
                    panic_with_error!(env, PoolError::NullifierSpent);
                }
            }
        }
    }

    // incremental merkle tree insert: o(tree_depth) poseidon2 calls.
    // updates poolroot atomically in the same storage write as commitmentcount.
    // append a single commitment. loads poseidon2 params + tree state once.
    // single append (deposit / transfer / withdraw: 1-2 commitments per tx).
    // proven per-leaf incremental update; ~32 poseidon2 hashes.
    fn append_commitment_and_update_root(env: &Env, commitment: BytesN<32>) -> u32 {
        let diag: Vec<U256> = env.storage().instance().get(&DataKey::Poseidon2Diag).unwrap();
        let rc: Vec<Vec<U256>> = env.storage().instance().get(&DataKey::Poseidon2RC).unwrap();
        let zeros: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::Zeros).unwrap();
        let mut filled: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::FilledSubtrees).unwrap();
        let index: u32 = env.storage().instance().get(&DataKey::CommitmentCount).unwrap_or(0);
        if index == u32::MAX {
            panic_with_error!(env, PoolError::AmountOverflow);
        }

        env.storage().persistent().set(&PersistKey::Commitment(index), &commitment);
        env.storage().persistent().extend_ttl(
            &PersistKey::Commitment(index),
            COMMITMENT_TTL_LEDGERS,
            COMMITMENT_BUMP_TARGET,
        );

        let mut current = commitment;
        let mut idx = index;
        for level in 0..TREE_DEPTH {
            if idx % 2 == 0 {
                filled.set(level, current.clone());
                current = Self::poseidon2_hash_with(env, &diag, &rc, &current, &zeros.get(level).unwrap());
            } else {
                current = Self::poseidon2_hash_with(env, &diag, &rc, &filled.get(level).unwrap(), &current);
            }
            idx >>= 1;
        }

        env.storage().instance().set(&DataKey::FilledSubtrees, &filled);
        env.storage().instance().set(&DataKey::PoolRoot, &current);
        Self::push_root(env, &current);
        env.storage().instance().set(&DataKey::CommitmentCount, &(index + 1));
        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);

        index
    }

    // append n commitments to consecutive leaves using o(n + depth) poseidon2 hashes
    // instead of o(n * depth). a per-leaf insert costs ~31m cpu (32 hashes); 12 leaves
    // that way (~372m) blows the soroban budget. this folds the whole batch up the tree
    // level-by-level, so a 12-output batch is ~40 hashes total. produces an identical
    // tree (root + filledsubtrees) to n sequential single appends — see
    // test::batch_matches_sequential.
    fn append_commitments_batch(env: &Env, commitments: &Vec<BytesN<32>>) -> Vec<u32> {
        let n = commitments.len();
        let mut indices: Vec<u32> = Vec::new(env);
        if n == 0 {
            return indices;
        }

        let diag: Vec<U256> = env.storage().instance().get(&DataKey::Poseidon2Diag).unwrap();
        let rc: Vec<Vec<U256>> = env.storage().instance().get(&DataKey::Poseidon2RC).unwrap();
        let zeros: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::Zeros).unwrap();
        let mut filled: Vec<BytesN<32>> = env.storage().instance().get(&DataKey::FilledSubtrees).unwrap();
        let start: u32 = env.storage().instance().get(&DataKey::CommitmentCount).unwrap_or(0);
        if start > u32::MAX - n {
            panic_with_error!(env, PoolError::AmountOverflow);
        }

        // persist each leaf + record its index.
        for i in 0..n {
            let idx = start + i;
            let c = commitments.get(i).unwrap();
            env.storage().persistent().set(&PersistKey::Commitment(idx), &c);
            env.storage().persistent().extend_ttl(
                &PersistKey::Commitment(idx),
                COMMITMENT_TTL_LEDGERS,
                COMMITMENT_BUMP_TARGET,
            );
            indices.push_back(idx);
        }

        // fold the new leaves up the tree. `layer` = affected node values at the
        // current level; `pos0` = tree position of layer[0] at that level.
        let mut layer: Vec<BytesN<32>> = commitments.clone();
        let mut pos0: u32 = start;
        for level in 0..TREE_DEPTH {
            let mut next: Vec<BytesN<32>> = Vec::new(env);
            let len = layer.len();
            let mut i: u32 = 0;

            // left boundary: if layer[0] is at an odd position it is a right child;
            // pair it with the existing left sibling stored in filled[level].
            if pos0 % 2 == 1 {
                let combined = Self::poseidon2_hash_with(
                    env, &diag, &rc, &filled.get(level).unwrap(), &layer.get(0).unwrap(),
                );
                next.push_back(combined);
                i = 1;
            }

            // remaining nodes begin on an even (left-child) position.
            while i < len {
                let left = layer.get(i).unwrap();
                if i + 1 < len {
                    let right = layer.get(i + 1).unwrap();
                    next.push_back(Self::poseidon2_hash_with(env, &diag, &rc, &left, &right));
                } else {
                    // unpaired trailing left child: becomes the waiting left sibling at
                    // this level and folds with the empty (zero) right subtree.
                    filled.set(level, left.clone());
                    next.push_back(Self::poseidon2_hash_with(env, &diag, &rc, &left, &zeros.get(level).unwrap()));
                }
                i += 2;
            }

            layer = next;
            pos0 /= 2;
        }

        let new_root = layer.get(0).unwrap();
        env.storage().instance().set(&DataKey::FilledSubtrees, &filled);
        env.storage().instance().set(&DataKey::PoolRoot, &new_root);
        Self::push_root(env, &new_root);
        env.storage().instance().set(&DataKey::CommitmentCount, &(start + n));
        env.storage().instance().extend_ttl(ROOT_TTL_LEDGERS, ROOT_BUMP_TARGET);

        indices
    }

    // record a new root in the bounded recent-roots history (drops the oldest
    // once the window is full). upgrade-safe: if the history was never seeded
    // (pool deployed before this feature), it starts fresh here.
    fn push_root(env: &Env, root: &BytesN<32>) {
        let mut history: Vec<BytesN<32>> = env.storage().instance()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(env));
        history.push_back(root.clone());
        while history.len() > ROOT_HISTORY_SIZE {
            history.remove(0);
        }
        env.storage().instance().set(&DataKey::RootHistory, &history);
    }

    // true if `root` is the current root or any root in the recent window. used
    // by spend operations so a proof built against a slightly-stale-but-recent
    // root still verifies (the tree is append-only, so membership still holds).
    fn is_known_root(env: &Env, root: &BytesN<32>) -> bool {
        let current: BytesN<32> = env.storage().instance()
            .get(&DataKey::PoolRoot)
            .unwrap_or_else(|| panic_with_error!(env, PoolError::NotInitialized));
        if *root == current {
            return true;
        }
        let history: Vec<BytesN<32>> = env.storage().instance()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(env));
        for r in history.iter() {
            if r == *root {
                return true;
            }
        }
        false
    }

    // bn254 poseidon2 two-input hash using pre-loaded parameters.
    // critical: the round-constant table (vec<vec<u256>>, 256 elements) must not
    // be re-read from storage per hash — that deserialization, repeated 32x per
    // append, is what blew the cpu budget on multi-output (batch) transactions.
    fn poseidon2_hash_with(
        env: &Env,
        diag: &Vec<U256>,
        rc: &Vec<Vec<U256>>,
        left: &BytesN<32>,
        right: &BytesN<32>,
    ) -> BytesN<32> {
        let mut input: Vec<U256> = Vec::new(env);
        input.push_back(U256::from_be_bytes(env, &Bytes::from_array(env, &left.to_array())));
        input.push_back(U256::from_be_bytes(env, &Bytes::from_array(env, &right.to_array())));
        input.push_back(U256::from_u32(env, 0));
        input.push_back(U256::from_u32(env, 0));

        let output = env.crypto_hazmat().poseidon2_permutation(
            &input,
            symbol_short!("BN254"),
            4,   // t
            5,   // d (S-box x^5)
            8,   // rounds_f
            56,  // rounds_p
            diag,
            rc,
        );

        let out: U256 = output.get(0).unwrap();
        let out_bytes: Bytes = out.to_be_bytes();
        let mut arr = [0u8; 32];
        for i in 0u32..32 {
            arr[i as usize] = out_bytes.get(i).unwrap();
        }
        BytesN::<32>::from_array(env, &arr)
    }

    // convenience wrapper that loads the params once per call (used by one-off
    // hashing such as initialize()). hot paths use poseidon2_hash_with directly.
    fn poseidon2_hash(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
        let diag: Vec<U256> = env.storage().instance().get(&DataKey::Poseidon2Diag).unwrap();
        let rc: Vec<Vec<U256>> = env.storage().instance().get(&DataKey::Poseidon2RC).unwrap();
        Self::poseidon2_hash_with(env, &diag, &rc, left, right)
    }

    fn i128_to_hash32(env: &Env, v: i128) -> BytesN<32> {
        let mut buf = [0u8; 32];
        let uv: u128 = if v < 0 { 0 } else { v as u128 };
        let bytes = uv.to_be_bytes();
        buf[16..32].copy_from_slice(&bytes);
        BytesN::<32>::from_array(env, &buf)
    }

    fn hash_address(env: &Env, addr: &Address) -> BytesN<32> {
        let addr_str = addr.to_string();
        let bytes_val: Bytes = addr_str.into();
        let mut buf = env.crypto().sha256(&bytes_val).to_array();
        buf[0] = 0;
        BytesN::<32>::from_array(env, &buf)
    }
}

// tests
#[cfg(test)]
mod test;
