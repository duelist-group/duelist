#!/usr/bin/env bash
# 01-build.sh — UltraHonk build pipeline
# =====================================
#
# Pipeline:
#   1. nargo compile            (Noir source → ACIR artifact JSON)
#   2. bb write_vk              (one VK file per circuit, raw bytes for the contract)
#   3. stellar contract build   (Rust → optimized WASM)
#   4. Copy circuit artifacts into dapp/public/circuits/ for client-side proving
#
# What changed vs Groth16 build:
#   • Universal Powers of Tau (no per-circuit ceremony, no .zkey files)
#   • No noir-cli interop, no R1CS, no snarkjs
#   • No vk_extract.js → vk_data.rs (VK is set at deploy time on the contract)
#   • Build time drops from ~hours to ~minutes
#
# Verifier ABI assumption:
#   set_deposit_vk(vk: Bytes) / set_transfer_vk(vk: Bytes) / set_withdraw_vk(vk: Bytes)
#   are called by 02-deploy.sh after `stellar contract deploy` completes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
header() { printf "\n\033[1;34m=== %s ===\033[0m\n" "$1"; }

CIRCUITS_DIR="$ROOT/circuits"
DAPP_PUBLIC="$ROOT/dapp/public/circuits"
CIRCUITS=(deposit transfer withdraw_small withdraw_large transfer_batch)

# ── 0. Prereqs ────────────────────────────────────────────────────────────
header "0/4  Checking prerequisites"
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "✗ Missing required tool: $1"
    red "  $2"
    exit 1
  fi
  green "  ✓ $1: $(command -v "$1")"
}
need cargo   "Install via https://rustup.rs"
need nargo   "Install via noirup (see 00-prereqs.sh)"
need bb      "Install via bbup (see 00-prereqs.sh)"
need stellar "cargo install --locked stellar-cli --features opt"

EXPECTED_NARGO="1.0.0-beta.9"
EXPECTED_BB="0.87.0"
ACTUAL_NARGO="$(nargo --version 2>/dev/null | head -1 | awk '{print $NF}')"
ACTUAL_BB="$(bb --version 2>/dev/null | head -1)"
if [ "$ACTUAL_NARGO" != "$EXPECTED_NARGO" ]; then
  red "✗ nargo version mismatch: have $ACTUAL_NARGO, need $EXPECTED_NARGO"
  red "  Run: noirup -v $EXPECTED_NARGO"
  exit 1
fi
if [ "$ACTUAL_BB" != "$EXPECTED_BB" ]; then
  red "✗ bb version mismatch: have $ACTUAL_BB, need $EXPECTED_BB"
  red "  Run: bbup -v $EXPECTED_BB"
  exit 1
fi
green "  ✓ nargo: $ACTUAL_NARGO"
green "  ✓ bb:    $ACTUAL_BB"

mkdir -p "$DAPP_PUBLIC"

# ── 1. nargo compile ───────────────────────────────────────────────────────
header "1/4  Compiling Noir circuits (nargo)"
cd "$CIRCUITS_DIR"
for circuit in "${CIRCUITS[@]}"; do
  yellow "  compiling $circuit..."
  nargo compile --package "$circuit"
done
green "✓ All circuits compiled."
ls -lh "$CIRCUITS_DIR/target/"*.json

# ── 2. bb write_vk ─────────────────────────────────────────────────────────
# Why --oracle_hash keccak:
#   The indextree UltraHonk Soroban verifier was built and tested with
#   --oracle_hash keccak (matches its sample circuit). Soroban exposes
#   keccak256 as a host fn, so it's the cheapest in-circuit transcript hash
#   on this platform. If you swap the engine later for a poseidon-transcript
#   verifier, change this flag to match.
header "2/4  Generating UltraHonk verification keys (bb write_vk)"
for circuit in "${CIRCUITS[@]}"; do
  ARTIFACT="$CIRCUITS_DIR/target/${circuit}.json"
  VK_OUT_DIR="$CIRCUITS_DIR/target/${circuit}_vk"
  rm -rf "$VK_OUT_DIR"
  mkdir -p "$VK_OUT_DIR"
  yellow "  $circuit: bb write_vk..."
  bb write_vk \
    --scheme ultra_honk \
    --oracle_hash keccak \
    -b "$ARTIFACT" \
    -o "$VK_OUT_DIR"
  if [ ! -f "$VK_OUT_DIR/vk" ]; then
    red "✗ bb did not produce $VK_OUT_DIR/vk"
    red "  Newer bb versions may name it differently — check the bb output above."
    exit 1
  fi
  green "  ✓ $circuit VK at $VK_OUT_DIR/vk ($(wc -c <"$VK_OUT_DIR/vk") bytes)"
done

# ── 3. stellar contract build ──────────────────────────────────────────────
header "3/4  Building Soroban contracts"
cd "$ROOT/contracts"
rustup target add wasm32v1-none >/dev/null 2>&1 || true
mkdir -p "$ROOT/contracts/wasms"
stellar contract build --optimize --out-dir "$ROOT/contracts/wasms"
green "✓ Contracts built."
ls -lh "$ROOT/contracts/wasms/"*.wasm 2>/dev/null || true

# ── 4. Stage dapp artifacts ────────────────────────────────────────────────
# The browser needs:
#   • <circuit>.json   — compiled ACIR (used by @noir-lang/noir_js for witness gen)
#   • <circuit>.vk     — UltraHonk VK bytes (passed to bb.js verifier alongside proof)
# Note: there is NO zkey to ship anymore.
header "4/4  Staging dapp circuit artifacts"
for circuit in "${CIRCUITS[@]}"; do
  cp "$CIRCUITS_DIR/target/${circuit}.json"     "$DAPP_PUBLIC/${circuit}.json"
  cp "$CIRCUITS_DIR/target/${circuit}_vk/vk"    "$DAPP_PUBLIC/${circuit}.vk"
  green "  ✓ $circuit assets copied"
done

echo
green "═══════════════════════════════════════════════════════════════"
green "                    BUILD COMPLETE"
green "═══════════════════════════════════════════════════════════════"
echo
echo "Proof system : UltraHonk over BN254"
echo "Verifier     : indextree/ultrahonk_soroban_contract (deployed separately)"
echo "Contracts    : $ROOT/contracts/wasms/"
echo "DApp assets  : $DAPP_PUBLIC/  (no zkeys; UltraHonk needs no per-circuit trusted setup)"
echo
echo "Next step: bash deploy/scripts/02-deploy.sh"
echo
