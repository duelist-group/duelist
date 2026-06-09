# Duelist

A shielded-pool privacy protocol for payments on Stellar. Shield your balance, send
confidentially, run payroll, and cash out, all over native USDC, EURC, and XLM. Private by
default, auditable when it has to be.

Stablecoins made money digital but never private. On a normal chain every transfer sits on a
public explorer forever: your salary, your runway, the people you pay. Duelist puts that
money inside a shielded pool where balances live as encrypted notes and every transfer is
settled with a zero-knowledge proof. Amounts and counterparties stay hidden. The deposit and
withdraw edges, where money enters and leaves, are screened against sanctions lists, and
anyone you hand a viewing key can still audit the full history.

This repository is the whole protocol: the Noir circuits, the Soroban contracts, the indexer,
the relayer, the SDK, and the web app.

> Status: deployed and working on Stellar **testnet**, pre-audit. Behaviour and numbers below
> are reproducible against the running code. Do not put real money on a mainnet fork of this
> before it has been through a proper security review.

## What it does

- **Deposit** public USDC, EURC, or XLM into the pool. The depositor is screened at this edge.
- **Send** a private note to any `zk1...` shielded address, amount and recipient hidden.
- **Payroll**: pay up to 10 recipients in a single proof and a single transaction.
- **Withdraw**: combine up to 16 notes and cash out to a public `G...` address, screened.

Every spend also writes a change note back to you plus a zero-value decoy, so how many real
outputs there were, and how many people you actually paid, never shows up on-chain.

## How it works

Money in the pool is a set of *commitments*, hashes that lock in `{owner, asset, amount,
blinding}` and on their own reveal nothing. To spend a note you publish a *nullifier* that
marks it used (the chain rejects any nullifier it has already seen, so there is no double
spend) together with a proof that you own enough notes, that value balances (in = out + fee),
and that every nullifier is unique. None of that exposes which notes you touched or for how
much.

| On-chain, anyone sees | Hidden, only you or a viewing key |
|---|---|
| Commitments and nullifiers | Amounts |
| The deposit and withdraw edges | Sender to recipient links |
| That *a* shielded tx happened | Who paid whom, and how much |

The edges are public because money has to enter and leave somewhere. Everything between them
is private. That holds for every shielded pool, and it is better to say so plainly than to
pretend the edges do not exist.

## The zero-knowledge stack

- **Noir** for the circuits.
- **UltraHonk** (Barretenberg, `bb.js`) for proving, compiled to WebAssembly and run *client
  side*, multithreaded, inside a Web Worker. Key material never touches the main thread and
  never leaves the device.
- **Poseidon2** for hashing, kept byte-identical across the circuit, the SDK, and the indexer
  so the Merkle roots actually agree.
- **Schnorr over BabyJubJub** for note ownership, proven against a depth-32 append-only Merkle
  tree of commitments.

UltraHonk uses a universal, reusable powers-of-tau setup that every circuit shares, so there
is **no per-circuit trusted setup**. That is the precise claim. It is not "zero trusted setup"
(that would be a STARK), and it is not "faster than Groth16" (Groth16 has tiny proofs and fast
native proving). What the universal setup buys is one ceremony for the entire asset range and
a prover that survives on a phone, which is the part that matters for payments.

### Circuits and proof sizes

| Operation | Circuit | Gates |
|---|---|---:|
| Deposit | `deposit` | 2,971 |
| Send | `transfer` (2 in / 2 out) | 16,495 |
| Withdraw, up to 4 notes | `withdraw_small` | 22,652 |
| Withdraw, up to 16 notes | `withdraw_large` | 59,300 |
| Payroll, up to 10 recipients | `transfer_batch` (16 in / 12 out) | 61,616 |

The proof is a constant **14,592 bytes** and the verification key is **1,760 bytes** per
circuit, whether you move one note or sixteen, pay one person or ten. A ten-person payroll
lands the same on-chain footprint as a single send.

Measured proving time on the heaviest path, the 10-recipient payroll, is about **26 seconds on
an iPhone SE (3rd gen)** and 5 to 6 seconds on a desktop. Deposits prove in well under a
second. Every figure is reproducible from `circuits/` with `bb gates` / `bb prove` / `bb
verify` and from the dapp's worker.

## Repository layout

```
circuits/     Noir circuits: deposit, transfer, transfer_batch, withdraw_small, withdraw_large,
              and the shared lib_shield helpers (notes, Merkle, nullifiers, Schnorr).
contracts/    Soroban contracts (Rust):
                pool        the shielded pool: verify, nullify, append, screen the edges
                verifier    UltraHonk verifier dispatcher plus one engine per circuit
                compliance  the sanctions oracle (is_clean), behind multisig + timelock
indexer/      Rebuilds the Merkle tree from on-chain events and serves tree proofs + state.
relayer/      The "Carrier": submits transactions and pays the gas so the user spends none,
              plus the self-funding "Healer" loop that keeps rent and relayer gas topped up.
sdk/          TypeScript SDK (keys, notes, proof inputs) for building on top of the protocol.
dapp/         React + Vite app with the bb.js prover worker.
deploy/       Build and deploy scripts, nginx config template.
```

## Building

You need the Noir toolchain (`nargo` and Barretenberg `bb`), the Stellar CLI, a Rust
toolchain with the wasm target, and Node (version in `.nvmrc`). `deploy/scripts/00-prereqs.sh`
installs whatever is missing.

```
make build          # compile circuits + contracts, copy circuit artifacts into the dapp
make deploy-testnet # deploy your OWN fresh contracts to Stellar testnet
make dev            # the dapp dev server on its own
make up             # the whole stack against testnet (after the .env files are filled)
make clean
```

The compiled circuit artifacts (`dapp/public/circuits/`) and the Barretenberg wasm are build
outputs and stay out of git; `make build` regenerates the circuit artifacts and the wasm ships
with the `bb.js` and Noir packages. Copy each `*/.env.example` to `*/.env` and fill in the
contract ids that the deploy step prints.

A normal local run, end to end: build, deploy your own contracts to testnet, start the indexer
and the relayer, then start the dapp pointed at both.

## Compliance, briefly

Privacy and compliance are built here to hold at the same time rather than fight each other.
Funds are screened against sanctions lists at the two public edges, deposit and withdraw, so
the pool cannot quietly turn into a laundromat. A holder can give an accountant, an auditor, or
a regulator a read-only viewing key that shows exactly the history they are owed and nothing
more. Honest users can prove their funds came from a clean source. The sanctions oracle sits
behind an M-of-N multisig and a timelock, so no single key can silently change what is allowed.

The longer write-up, with diagrams, is in the docs: [duelist.gitbook.io](https://duelist.gitbook.io).

## Credits

Duelist stands on a lot of open-source work, including yugocabrio's
[`rs-soroban-ultrahonk`](https://github.com/yugocabrio/rs-soroban-ultrahonk) (MIT) for on-chain
verification, Noir and Barretenberg for the proving stack, and the Stellar SDKs. The full list
is in [CREDITS.md](CREDITS.md).

## License

The source is published for transparency, review, and a reproducible build. It is not yet
licensed for production reuse.
