// contracts/compliance/src/lib.rs
// shield protocol — compliance / blacklist oracle contract.
// Maintains the canonical blacklist Merkle root that is referenced (in v2+)
// by the optional poi proof generation in the sdk. updates are governed by:
// an m-of-n multisig of regulator-approved signatories.
// a 30-day timelock between proposal and execution (user protection).
//   - Proposals must include a citation reference (e.g. OFAC SDN entry ID)
// stored on-chain for transparency.
// in v1 (railgun model) the blacklist is not used by the transfer/withdraw
// circuits — only by the off-chain relayer for deposit screening, and by
// optional user-generated compliance proofs. this contract provides the
// canonical, auditable source of truth.

#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, BytesN, Bytes, Env, Vec, Symbol, symbol_short,
    panic_with_error, IntoVal,
};

const TIMELOCK_LEDGERS: u32 = 432_000; // ~30 days at 6s/ledger


#[contracttype]
pub enum DataKey {
    Admin,
    Pool,                          // pool contract Address (where to push root updates)
    SignatoryThreshold,            // M of multisig
    Signatories,                   // Vec<Address> N
    BlacklistRoot,
    NextProposalId,
    Proposal(u64),                 // u64 -> Proposal
    Approved(u64, Address),        // (proposal_id, signer) -> bool

    // v1 sanctions list (simple admin-managed)
    // the merkle-root path above (blacklistroot + zk non-inclusion proofs at
    // deposit) is the long-term plan. while that ships, the pool consults
    // this direct per-address mapping via `is_sanctioned`. updates require
    // either:
    // admin (centralized escape hatch — disabled by setting adminenabled=false), or
    // an executed multisig proposal of type sanctionsaddproposal /
    // sanctionsremoveproposal (same m-of-n + timelock as root updates).
    // switching to mainnet ofac: see docs/compliance_migration.md.
    SanctionedAddr(Address),       // Address -> bool   (presence == sanctioned)
    AdminEnabled,                  // bool — admin can write directly while true
    SanctionsProposal(u64),        // SanctionsProposal
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SanctionsProposalKind {
    Add(Address),
    Remove(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct SanctionsProposal {
    pub kind: SanctionsProposalKind,
    pub citation: Bytes,
    pub proposed_ledger: u32,
    pub executable_after_ledger: u32,
    pub approval_count: u32,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub new_root: BytesN<32>,
    pub citation: Bytes,           // free-form reference (OFAC entry, court order, etc.)
    pub proposed_ledger: u32,
    pub executable_after_ledger: u32,
    pub approval_count: u32,
    pub executed: bool,
    pub cancelled: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ComplianceError {
    AlreadyInitialized       = 1,
    NotInitialized           = 2,
    Unauthorized             = 3,
    NotASignatory            = 4,
    ProposalNotFound         = 5,
    AlreadyApproved          = 6,
    AlreadyExecuted          = 7,
    AlreadyCancelled         = 8,
    TimelockActive           = 9,
    NotEnoughApprovals      = 10,
    BadThreshold            = 11,
}

#[contract]
pub struct Compliance;

#[contractimpl]
impl Compliance {
    pub fn initialize(
        env: Env,
        admin: Address,
        pool: Address,
        signatories: Vec<Address>,
        threshold: u32,
        initial_root: BytesN<32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, ComplianceError::AlreadyInitialized);
        }
        if threshold == 0 || threshold > signatories.len() {
            panic_with_error!(&env, ComplianceError::BadThreshold);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::Signatories, &signatories);
        env.storage().instance().set(&DataKey::SignatoryThreshold, &threshold);
        env.storage().instance().set(&DataKey::BlacklistRoot, &initial_root);
        env.storage().instance().set(&DataKey::NextProposalId, &0u64);
        // v1: admin can directly add/remove sanctions while bootstrapping.
        // after multisig governance is fully spun up, call `disable_admin()`
        // (one-way) and the m-of-n proposal flow becomes the only mutation path.
        env.storage().instance().set(&DataKey::AdminEnabled, &true);
    }

    pub fn propose_root_update(
        env: Env,
        signer: Address,
        new_root: BytesN<32>,
        citation: Bytes,
    ) -> u64 {
        signer.require_auth();
        Self::require_signatory(&env, &signer);

        let id: u64 = env.storage().instance().get(&DataKey::NextProposalId).unwrap_or(0);
        let current_ledger = env.ledger().sequence();
        let proposal = Proposal {
            new_root,
            citation,
            proposed_ledger: current_ledger,
            executable_after_ledger: current_ledger + TIMELOCK_LEDGERS,
            approval_count: 1,  // proposer auto-approves
            executed: false,
            cancelled: false,
        };
        env.storage().persistent().set(&DataKey::Proposal(id), &proposal);
        env.storage().persistent().set(&DataKey::Approved(id, signer.clone()), &true);
        env.storage().instance().set(&DataKey::NextProposalId, &(id + 1));

        env.events().publish(
            (symbol_short!("propose"), id),
            (signer, proposal.new_root),
        );
        id
    }

    pub fn approve(env: Env, signer: Address, proposal_id: u64) {
        signer.require_auth();
        Self::require_signatory(&env, &signer);

        if env.storage().persistent()
            .get::<_, bool>(&DataKey::Approved(proposal_id, signer.clone()))
            .unwrap_or(false)
        {
            panic_with_error!(&env, ComplianceError::AlreadyApproved);
        }

        let mut proposal: Proposal = env.storage().persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, ComplianceError::ProposalNotFound));

        if proposal.executed {
            panic_with_error!(&env, ComplianceError::AlreadyExecuted);
        }
        if proposal.cancelled {
            panic_with_error!(&env, ComplianceError::AlreadyCancelled);
        }

        proposal.approval_count += 1;
        env.storage().persistent().set(&DataKey::Approved(proposal_id, signer.clone()), &true);
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish((symbol_short!("approve"), proposal_id), signer);
    }

    pub fn execute(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        Self::require_signatory(&env, &caller);

        let mut proposal: Proposal = env.storage().persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, ComplianceError::ProposalNotFound));
        if proposal.executed {
            panic_with_error!(&env, ComplianceError::AlreadyExecuted);
        }
        if proposal.cancelled {
            panic_with_error!(&env, ComplianceError::AlreadyCancelled);
        }
        if env.ledger().sequence() < proposal.executable_after_ledger {
            panic_with_error!(&env, ComplianceError::TimelockActive);
        }
        let threshold: u32 = env.storage().instance().get(&DataKey::SignatoryThreshold).unwrap();
        if proposal.approval_count < threshold {
            panic_with_error!(&env, ComplianceError::NotEnoughApprovals);
        }

        proposal.executed = true;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);

        // update local record
        env.storage().instance().set(&DataKey::BlacklistRoot, &proposal.new_root);

        // push the new root to the pool contract.
        let pool: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
        let _: () = env.invoke_contract(
            &pool,
            &Symbol::new(&env, "update_blacklist_root"),
            (env.current_contract_address(), proposal.new_root.clone()).into_val(&env),
        );

        env.events().publish((symbol_short!("executed"), proposal_id), proposal.new_root);
    }

    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, ComplianceError::Unauthorized);
        }
        let mut proposal: Proposal = env.storage().persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, ComplianceError::ProposalNotFound));
        if proposal.executed || proposal.cancelled {
            panic_with_error!(&env, ComplianceError::AlreadyExecuted);
        }
        proposal.cancelled = true;
        env.storage().persistent().set(&DataKey::Proposal(proposal_id), &proposal);
        env.events().publish((symbol_short!("cancel"), proposal_id), caller);
    }

    // views
    pub fn blacklist_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::BlacklistRoot).unwrap()
    }

    pub fn proposal(env: Env, id: u64) -> Proposal {
        env.storage().persistent().get(&DataKey::Proposal(id)).unwrap()
    }

    fn require_signatory(env: &Env, addr: &Address) {
        let signatories: Vec<Address> = env.storage().instance().get(&DataKey::Signatories).unwrap();
        let mut found = false;
        for s in signatories.iter() {
            if s == *addr { found = true; break; }
        }
        if !found {
            panic_with_error!(env, ComplianceError::NotASignatory);
        }
    }

    // v1 sanctions list (simple, admin-managed; multisig fallback path)

    /// pool contract calls this on every deposit (and may call it on withdraw
    /// for the on-chain recipient too). returns true if the address is not on
    /// the sanctions list. cheap o(1) storage lookup.
    pub fn is_clean(env: Env, addr: Address) -> bool {
        !env.storage()
            .persistent()
            .get::<_, bool>(&DataKey::SanctionedAddr(addr))
            .unwrap_or(false)
    }

    /// admin: add one address (only while adminenabled).
    /// for multisig, use `propose_sanctions(add(addr), citation)`.
    pub fn admin_add_sanction(env: Env, addr: Address, citation: Bytes) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        Self::require_admin_enabled(&env);
        env.storage().persistent().set(&DataKey::SanctionedAddr(addr.clone()), &true);
        env.events().publish((symbol_short!("sanc_add"),), (addr, citation));
    }

    /// admin: remove one address.
    pub fn admin_remove_sanction(env: Env, addr: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        Self::require_admin_enabled(&env);
        env.storage().persistent().remove(&DataKey::SanctionedAddr(addr.clone()));
        env.events().publish((symbol_short!("sanc_rm"),), addr);
    }

    /// one-way: disable admin direct writes, leaving only the multisig
    /// proposal flow. cannot be re-enabled. run this when governance is ready.
    pub fn disable_admin(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::AdminEnabled, &false);
        env.events().publish((symbol_short!("admin_off"),), ());
    }

    pub fn admin_enabled(env: Env) -> bool {
        env.storage().instance().get(&DataKey::AdminEnabled).unwrap_or(true)
    }

    fn require_admin_enabled(env: &Env) {
        let enabled: bool = env.storage().instance().get(&DataKey::AdminEnabled).unwrap_or(true);
        if !enabled {
            panic_with_error!(env, ComplianceError::Unauthorized);
        }
    }

    // multisig path for sanctions changes (works even after disable_admin)

    /// any signatory may propose adding or removing an address.
    /// uses the same timelock_ledgers and threshold as root proposals.
    pub fn propose_sanctions(
        env: Env,
        signer: Address,
        kind: SanctionsProposalKind,
        citation: Bytes,
    ) -> u64 {
        signer.require_auth();
        Self::require_signatory(&env, &signer);

        let id: u64 = env.storage().instance().get(&DataKey::NextProposalId).unwrap_or(0);
        let current_ledger = env.ledger().sequence();
        let proposal = SanctionsProposal {
            kind,
            citation,
            proposed_ledger: current_ledger,
            executable_after_ledger: current_ledger + TIMELOCK_LEDGERS,
            approval_count: 1,
            executed: false,
            cancelled: false,
        };
        env.storage().persistent().set(&DataKey::SanctionsProposal(id), &proposal);
        env.storage().persistent().set(&DataKey::Approved(id, signer.clone()), &true);
        env.storage().instance().set(&DataKey::NextProposalId, &(id + 1));
        env.events().publish((symbol_short!("s_prop"), id), signer);
        id
    }

    pub fn approve_sanctions(env: Env, signer: Address, proposal_id: u64) {
        signer.require_auth();
        Self::require_signatory(&env, &signer);

        if env.storage().persistent()
            .get::<_, bool>(&DataKey::Approved(proposal_id, signer.clone()))
            .unwrap_or(false)
        {
            panic_with_error!(&env, ComplianceError::AlreadyApproved);
        }
        let mut proposal: SanctionsProposal = env.storage().persistent()
            .get(&DataKey::SanctionsProposal(proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, ComplianceError::ProposalNotFound));
        if proposal.executed  { panic_with_error!(&env, ComplianceError::AlreadyExecuted);  }
        if proposal.cancelled { panic_with_error!(&env, ComplianceError::AlreadyCancelled); }

        proposal.approval_count += 1;
        env.storage().persistent().set(&DataKey::Approved(proposal_id, signer.clone()), &true);
        env.storage().persistent().set(&DataKey::SanctionsProposal(proposal_id), &proposal);
        env.events().publish((symbol_short!("s_apprv"), proposal_id), signer);
    }

    pub fn execute_sanctions(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        Self::require_signatory(&env, &caller);

        let mut proposal: SanctionsProposal = env.storage().persistent()
            .get(&DataKey::SanctionsProposal(proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, ComplianceError::ProposalNotFound));
        if proposal.executed  { panic_with_error!(&env, ComplianceError::AlreadyExecuted);  }
        if proposal.cancelled { panic_with_error!(&env, ComplianceError::AlreadyCancelled); }
        if env.ledger().sequence() < proposal.executable_after_ledger {
            panic_with_error!(&env, ComplianceError::TimelockActive);
        }
        let threshold: u32 = env.storage().instance().get(&DataKey::SignatoryThreshold).unwrap();
        if proposal.approval_count < threshold {
            panic_with_error!(&env, ComplianceError::NotEnoughApprovals);
        }

        match &proposal.kind {
            SanctionsProposalKind::Add(addr) => {
                env.storage().persistent().set(&DataKey::SanctionedAddr(addr.clone()), &true);
            }
            SanctionsProposalKind::Remove(addr) => {
                env.storage().persistent().remove(&DataKey::SanctionedAddr(addr.clone()));
            }
        }

        proposal.executed = true;
        env.storage().persistent().set(&DataKey::SanctionsProposal(proposal_id), &proposal);
        env.events().publish((symbol_short!("s_exec"), proposal_id), ());
    }
}
