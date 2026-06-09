#!/usr/bin/env bash
# 03-run-dapp.sh
# Install deps, start indexer + relayer + dapp dev server.
#
# Usage: bash 03-run-dapp.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }

# ── Load deployed addresses ──
if [ -f "$ROOT/deploy/addresses.testnet.env" ]; then
  source "$ROOT/deploy/addresses.testnet.env"
fi

POOL_CONTRACT="${VITE_POOL_CONTRACT:-}"
RELAYER_SECRET="${RELAYER_SECRET:-}"

# ── 1. Install + build the SDK ──
yellow "[1/5] Installing SDK dependencies…"
cd "$ROOT/sdk"
npm install --legacy-peer-deps 2>/dev/null || yarn install
npx tsc -p tsconfig.json 2>/dev/null || true
green "✓ SDK ready."

# ── 2. Link SDK into dapp ──
yellow "[2/5] Linking SDK into dapp…"
cd "$ROOT/dapp"
if ! grep -q '"@shield-protocol/sdk":' package.json; then
  npm pkg set "dependencies.@shield-protocol/sdk=file:../sdk"
fi
npm install --legacy-peer-deps 2>/dev/null || yarn install
green "✓ DApp dependencies installed."

# ── 3. Start the indexer (background) ──
if [ -n "$POOL_CONTRACT" ]; then
  yellow "[3/5] Starting indexer on http://localhost:3001…"
  cd "$ROOT/indexer"
  npm install --legacy-peer-deps 2>/dev/null || yarn install
  POOL_CONTRACT="$POOL_CONTRACT" npx tsx src/server.ts &
  INDEXER_PID=$!
  sleep 2
  green "✓ Indexer started (PID $INDEXER_PID)."
else
  yellow "[3/5] Skipping indexer (no POOL_CONTRACT set)."
fi

# ── 4. Start the relayer (background, optional) ──
if [ -n "$RELAYER_SECRET" ] && [ -n "$POOL_CONTRACT" ]; then
  yellow "[4/5] Starting relayer on http://localhost:3002…"
  cd "$ROOT/relayer"
  npm install --legacy-peer-deps 2>/dev/null || yarn install
  POOL_CONTRACT="$POOL_CONTRACT" RELAYER_SECRET="$RELAYER_SECRET" npx tsx src/server.ts &
  RELAYER_PID=$!
  sleep 2
  green "✓ Relayer started (PID $RELAYER_PID)."
else
  yellow "[4/5] Skipping relayer (set RELAYER_SECRET to enable)."
fi

# ── 5. Start dapp dev server ──
yellow "[5/5] Starting dapp on http://localhost:5173…"
cd "$ROOT/dapp"
echo ""
echo "Services running:"
echo "  Dapp:     http://localhost:5173"
echo "  Indexer:  http://localhost:3001 ${POOL_CONTRACT:+(tracking $POOL_CONTRACT)}"
echo "  Relayer:  http://localhost:3002 ${RELAYER_SECRET:+(active)}"
echo ""
echo "Make sure you have:"
echo "  - Freighter wallet installed (browser extension)"
echo "  - Freighter set to TESTNET"
echo "  - Some testnet XLM in your wallet (use friendbot if needed)"
echo ""

# Trap to kill background processes on exit
trap 'kill $INDEXER_PID $RELAYER_PID 2>/dev/null; exit' EXIT INT TERM

exec npx vite
