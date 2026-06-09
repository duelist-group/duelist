#!/usr/bin/env bash
# 00-prereqs.sh
# Install pinned toolchain for Shield Protocol.
#
# Pinned versions (officially paired via bb-versions.json):
#   nargo : 1.0.0-beta.19
#   bb    : 4.0.0-nightly.20260120
#
# Source: https://raw.githubusercontent.com/AztecProtocol/aztec-packages/next/barretenberg/bbup/bb-versions.json
#
# These MUST match each other AND must match @aztec/bb.js in sdk/package.json.
# Do NOT upgrade nargo without checking the bb-versions.json mapping first.

set -euo pipefail

NARGO_VERSION="1.0.0-beta.19"
BB_VERSION="4.0.0-nightly.20260120"

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }

echo "============================================="
echo "Shield Protocol — Toolchain Installer"
echo "  nargo : $NARGO_VERSION"
echo "  bb    : $BB_VERSION"
echo "  (officially paired per bb-versions.json)"
echo "============================================="

# ── 1. Rust + wasm32v1-none ───────────────────────────────────────────────
if ! command -v rustup >/dev/null 2>&1; then
  yellow "Installing rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "$HOME/.cargo/env"
fi
green "✓ Rust: $(rustc --version)"
rustup target add wasm32v1-none 2>/dev/null && green "✓ wasm32v1-none added" || {
  yellow "  wasm32v1-none unavailable — using wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
}

# ── 2. Stellar CLI ────────────────────────────────────────────────────────
if ! command -v stellar >/dev/null 2>&1; then
  yellow "Installing Stellar CLI…"
  cargo install --locked stellar-cli --features opt
fi
green "✓ Stellar CLI: $(stellar --version | head -n1)"

# ── 3. nargo — PINNED ────────────────────────────────────────────────────
if ! command -v noirup >/dev/null 2>&1; then
  yellow "Installing noirup…"
  curl -L https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" || true
  [ -f "$HOME/.zshrc"  ] && source "$HOME/.zshrc"  || true
  export PATH="$HOME/.nargo/bin:$PATH"
fi

CURRENT_NARGO=""
command -v nargo >/dev/null 2>&1 && CURRENT_NARGO="$(nargo --version 2>/dev/null | head -1 | awk '{print $NF}')" || true
if [ "$CURRENT_NARGO" != "$NARGO_VERSION" ]; then
  yellow "Installing nargo $NARGO_VERSION (have: ${CURRENT_NARGO:-none})…"
  noirup -v "$NARGO_VERSION"
  export PATH="$HOME/.nargo/bin:$PATH"
fi
green "✓ nargo: $(nargo --version | head -1)"

# ── 4. bb — PINNED ───────────────────────────────────────────────────────
if ! command -v bbup >/dev/null 2>&1; then
  yellow "Installing bbup…"
  curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" || true
  [ -f "$HOME/.zshrc"  ] && source "$HOME/.zshrc"  || true
  export PATH="$HOME/.bb:$PATH"
fi

CURRENT_BB=""
command -v bb >/dev/null 2>&1 && CURRENT_BB="$(bb --version 2>/dev/null | head -1)" || true
if [ "$CURRENT_BB" != "$BB_VERSION" ]; then
  yellow "Installing bb $BB_VERSION (have: ${CURRENT_BB:-none})…"
  bbup -v "$BB_VERSION"
  export PATH="$HOME/.bb:$PATH"
fi
green "✓ bb: $(bb --version 2>/dev/null | head -1)"

# ── 5. Node.js ───────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  red "✗ Node.js not found. Install Node 20+ and re-run."
  exit 1
fi
NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "✗ Node 20+ required (you have $(node -v))."
  exit 1
fi
green "✓ Node: $(node -v)"

# ── 6. Yarn (optional) ───────────────────────────────────────────────────
if ! command -v yarn >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || npm install -g corepack
  corepack enable 2>/dev/null || true
  corepack prepare yarn@stable --activate 2>/dev/null || true
fi
command -v yarn >/dev/null 2>&1 && green "✓ Yarn: $(yarn --version)" || yellow "⚠ Yarn not installed (npm works fine)."

echo ""
echo "============================================="
green "All prerequisites installed."
echo ""
echo "Pinned (officially paired):"
echo "  nargo  : $NARGO_VERSION"
echo "  bb CLI : $BB_VERSION"
echo "  bb.js  : $BB_VERSION  (in sdk/package.json)"
echo ""
echo "Next: bash deploy/scripts/01-build.sh"
echo "============================================="
