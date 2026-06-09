#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn create_test_env() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let verifier = Address::generate(&env);
    let compliance = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let depositor = Address::generate(&env);
    (env, admin, verifier, compliance, fee_recipient, depositor)
}

fn mock_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// helper: initialize contract (v2 — no initial_pool_root arg; root computed on-chain).
fn do_init(
    client: &ShieldedPoolClient,
    admin: &Address,
    verifier: &Address,
    compliance: &Address,
    fee_recipient: &Address,
    fee_bps: u32,
    bl: &BytesN<32>,
) {
    client.initialize(admin, verifier, compliance, fee_recipient, &fee_bps, bl);
}

#[test]
fn test_initialize_sets_state() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);

    let initial_bl = mock_hash(&env, 2);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &initial_bl);

    // pool root is the poseidon2 root of an empty depth-32 tree (non-zero).
    let root = client.pool_root();
    let zero = BytesN::from_array(&env, &[0u8; 32]);
    assert_ne!(root, zero);
    assert_eq!(client.blacklist_root(), initial_bl);
    assert_eq!(client.commitment_count(), 0);
    assert_eq!(client.is_paused(), false);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_double_init_fails() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    let bl = mock_hash(&env, 1);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_fee_out_of_range_rejected() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    let bl = mock_hash(&env, 1);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 5000, &bl);
}

#[test]
fn test_pause_unpause() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    let bl = mock_hash(&env, 1);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);
    assert_eq!(client.is_paused(), false);
    client.set_paused(&admin, &true);
    assert_eq!(client.is_paused(), true);
    client.set_paused(&admin, &false);
    assert_eq!(client.is_paused(), false);
}

#[test]
fn test_admin_handover() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    let bl = mock_hash(&env, 1);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);

    let new_admin = Address::generate(&env);
    client.propose_admin(&admin, &new_admin);
    client.accept_admin(&new_admin);

    let new_root = mock_hash(&env, 9);
    client.submit_new_pool_root(&new_admin, &new_root);
    assert_eq!(client.pool_root(), new_root);
}

#[test]
fn test_hash_address_known_strkey() {
    // diagnostic: verify hash_address output for a known g-address so the js worker
    // can reproduce it exactly.
    let env = Env::default();
    // use a fixed known testnet address
    let addr = Address::from_str(&env, "GB52O4573KXGBGOBT54OZQCH26Y74YC3F3767BTDBZKDI25MDXKOGY5P");
    let hash = ShieldedPool::hash_address(&env, &addr);
    let bytes = hash.to_array();
    extern crate std;
    use std::format;
    let hex: std::string::String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    std::eprintln!("hash_address(GB52O4573...GY5P) = 0x{}", hex);
    assert_eq!(bytes[0], 0, "First byte must always be 0");
}

// the batched insert must produce a byte-identical tree (root + filledsubtrees)
// to n sequential single appends, or proofs break. verify across boundary
// parities: different pre-fill counts (so the batch starts at even/odd positions)
// and different batch sizes.
#[test]
fn batch_matches_sequential() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let bl = mock_hash(&env, 1);

    for &(pre, n) in &[
        (0u32, 1u32), (0, 2), (0, 3), (0, 5), (0, 7), (0, 12),
        (1, 12), (2, 12), (3, 5), (5, 7), (4, 12), (7, 9),
    ] {
        // pool a — sequential single appends. pool b — one batched append.
        let id_a = env.register(ShieldedPool, ());
        let ca = ShieldedPoolClient::new(&env, &id_a);
        do_init(&ca, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);
        let id_b = env.register(ShieldedPool, ());
        let cb = ShieldedPoolClient::new(&env, &id_b);
        do_init(&cb, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);

        // identical pre-fill on both (sequential) so they share a starting state.
        for k in 0..pre {
            let leaf = mock_hash(&env, (100 + k) as u8);
            let la = leaf.clone();
            env.as_contract(&id_a, || { ShieldedPool::append_commitment_and_update_root(&env, la); });
            let lb = leaf.clone();
            env.as_contract(&id_b, || { ShieldedPool::append_commitment_and_update_root(&env, lb); });
        }

        let mut batch: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);
        for j in 0..n {
            batch.push_back(mock_hash(&env, (200 + j) as u8));
        }

        // a: sequential
        for j in 0..n {
            let leaf = batch.get(j).unwrap();
            env.as_contract(&id_a, || { ShieldedPool::append_commitment_and_update_root(&env, leaf); });
        }
        // b: batched
        let batch_b = batch.clone();
        env.as_contract(&id_b, || { ShieldedPool::append_commitments_batch(&env, &batch_b); });

        assert_eq!(ca.pool_root(), cb.pool_root(), "root mismatch pre={} n={}", pre, n);
        assert_eq!(ca.commitment_count(), cb.commitment_count(), "count mismatch pre={} n={}", pre, n);
    }
}

#[test]
fn test_nullifier_unspent_initially() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    let bl = mock_hash(&env, 1);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &bl);

    let null = mock_hash(&env, 42);
    assert_eq!(client.is_nullifier_spent(&null), false);
}

// recent-roots window: a root from a few appends ago is still accepted, and a
// never-seen root is rejected. this is what gives concurrent spenders liveness.
#[test]
fn root_history_accepts_recent_roots() {
    let (env, admin, verifier, compliance, fee_recipient, _) = create_test_env();
    let contract_id = env.register(ShieldedPool, ());
    let client = ShieldedPoolClient::new(&env, &contract_id);
    do_init(&client, &admin, &verifier, &compliance, &fee_recipient, 10, &mock_hash(&env, 1));

    env.as_contract(&contract_id, || {
        ShieldedPool::append_commitment_and_update_root(&env, mock_hash(&env, 10));
    });
    let root_old = client.pool_root();

    // advance the root with several more appends.
    for k in 0..5u8 {
        env.as_contract(&contract_id, || {
            ShieldedPool::append_commitment_and_update_root(&env, mock_hash(&env, 20 + k));
        });
    }
    let root_new = client.pool_root();
    assert_ne!(root_old, root_new);

    env.as_contract(&contract_id, || {
        // both the current root and the older recent root are accepted
        assert!(ShieldedPool::is_known_root(&env, &root_new));
        assert!(ShieldedPool::is_known_root(&env, &root_old));
        // an unrelated root is not
        assert!(!ShieldedPool::is_known_root(&env, &mock_hash(&env, 99)));
    });
}
