#!/usr/bin/env bash
# up.sh — ONE COMMAND to bring the whole stack alive against the already-deployed
# testnet contracts. Clone the repo, run `make up`, open the browser. Done.
#
# What it does (idempotent — safe to re-run):
#   1. checks Node >= 20
#   2. generates indexer/.env, relayer/.env, dapp/.env.local from the committed
#      testnet addresses (only if they don't already exist — your real secrets
#      are never overwritten)
#   3. if the relayer has no funded key, generates one and friendbot-funds it
#   4. npm install for indexer + relayer + dapp
#   5. starts indexer (:3001), relayer (:3002), dapp (:5173) and cleans them up
#      on Ctrl-C
#
# It does NOT deploy contracts. The testnet pool/verifier/engines are already
# live (see deploy/addresses.testnet.env). To deploy your OWN fresh contracts,
# use `make deploy-testnet` instead (needs the ZK toolchain + a funded key).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
hdr()    { printf "\n\033[1;34m=== %s ===\033[0m\n" "$1"; }

ADDR="$ROOT/deploy/addresses.testnet.env"
FRIENDBOT="https://friendbot.stellar.org"
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# ── 0. Node check ──────────────────────────────────────────────────────────
hdr "0/5  Checking Node"
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed. Install Node >= 20 from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Node $(node -v) is too old. This project needs Node >= 20."
  red "Tip: install nvm, then: nvm install 22 && nvm use 22"
  exit 1
fi
green "  ✓ Node $(node -v)"

if [ ! -f "$ADDR" ]; then
  red "Missing $ADDR — cannot find the deployed contract addresses."
  red "Either restore it, or run 'make deploy-testnet' to deploy your own."
  exit 1
fi
# read keys WITHOUT `source` — the file has values with spaces (e.g.
# "Stellar Testnet") that would be executed as commands by a naive source.
addr_get() { grep -E "^$1=" "$ADDR" | head -1 | cut -d= -f2-; }
VITE_POOL_CONTRACT="$(addr_get VITE_POOL_CONTRACT)"
VITE_VERIFIER_CONTRACT="$(addr_get VITE_VERIFIER_CONTRACT)"
VITE_COMPLIANCE_CONTRACT="$(addr_get VITE_COMPLIANCE_CONTRACT)"
VITE_ENGINE_DEPOSIT="$(addr_get VITE_ENGINE_DEPOSIT)"
VITE_ENGINE_TRANSFER="$(addr_get VITE_ENGINE_TRANSFER)"
VITE_ENGINE_TRANSFER_BATCH="$(addr_get VITE_ENGINE_TRANSFER_BATCH)"
VITE_ENGINE_WITHDRAW_SMALL="$(addr_get VITE_ENGINE_WITHDRAW_SMALL)"
VITE_ENGINE_WITHDRAW_LARGE="$(addr_get VITE_ENGINE_WITHDRAW_LARGE)"
VITE_XLM_CONTRACT="$(addr_get VITE_XLM_CONTRACT)"
VITE_USDC_CONTRACT="$(addr_get VITE_USDC_CONTRACT)"
VITE_EURC_CONTRACT="$(addr_get VITE_EURC_CONTRACT)"
if [ -z "$VITE_POOL_CONTRACT" ]; then
  red "Could not read VITE_POOL_CONTRACT from $ADDR — file may be malformed."
  exit 1
fi
green "  ✓ Loaded testnet addresses (pool ${VITE_POOL_CONTRACT:0:8}…)"

# ── 1. indexer/.env ────────────────────────────────────────────────────────
hdr "1/5  Config: indexer"
if [ -f "$ROOT/indexer/.env" ]; then
  green "  ✓ indexer/.env already exists (kept as-is)"
else
  cat > "$ROOT/indexer/.env" <<EOF
RPC_URL=$RPC_URL
POOL_CONTRACT=$VITE_POOL_CONTRACT
PORT=3001
POLL_INTERVAL_MS=5000
EOF
  green "  ✓ wrote indexer/.env"
fi

# ── 2. relayer/.env (+ funded key if missing) ──────────────────────────────
hdr "2/5  Config: relayer"
if [ -f "$ROOT/relayer/.env" ] && grep -q "^RELAYER_SECRET=S" "$ROOT/relayer/.env"; then
  green "  ✓ relayer/.env already has a key (kept as-is)"
else
  yellow "  no relayer key found — generating a fresh testnet keypair…"
  # install just enough to use the SDK's Keypair
  (cd "$ROOT/relayer" && npm install --silent --legacy-peer-deps >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1)
  KP=$(cd "$ROOT/relayer" && node -e '
    const { Keypair } = require("@stellar/stellar-sdk");
    const k = Keypair.random();
    process.stdout.write(k.secret() + " " + k.publicKey());
  ')
  RELAYER_SECRET="${KP%% *}"
  RELAYER_PUB="${KP##* }"
  yellow "  funding $RELAYER_PUB via friendbot…"
  curl -fsSL "${FRIENDBOT}/?addr=${RELAYER_PUB}" >/dev/null 2>&1 \
    && green "  ✓ relayer account funded" \
    || yellow "  (friendbot may be rate-limited; fund $RELAYER_PUB manually if relay fails)"

  cat > "$ROOT/relayer/.env" <<EOF
RPC_URL=$RPC_URL
NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
POOL_CONTRACT=$VITE_POOL_CONTRACT
VERIFIER_CONTRACT=$VITE_VERIFIER_CONTRACT
COMPLIANCE_CONTRACT=$VITE_COMPLIANCE_CONTRACT
RELAYER_SECRET=$RELAYER_SECRET
ADMIN_SECRET=
INDEXER_URL=http://localhost:3001
PORT=3002
ENGINE_DEPOSIT=$VITE_ENGINE_DEPOSIT
ENGINE_TRANSFER=$VITE_ENGINE_TRANSFER
ENGINE_TRANSFER_BATCH=$VITE_ENGINE_TRANSFER_BATCH
ENGINE_WITHDRAW_SMALL=$VITE_ENGINE_WITHDRAW_SMALL
ENGINE_WITHDRAW_LARGE=$VITE_ENGINE_WITHDRAW_LARGE
XLM_CONTRACT=$VITE_XLM_CONTRACT
USDC_CONTRACT=$VITE_USDC_CONTRACT
EURC_CONTRACT=$VITE_EURC_CONTRACT
KEEPALIVE_INTERVAL_HOURS=12
EOF
  green "  ✓ wrote relayer/.env (fresh funded key)"
  yellow "  note: ADMIN_SECRET is empty — pool-root updates after deposit are"
  yellow "        admin-gated to the original deployer, so they are skipped. This"
  yellow "        is fine for a read/prove demo. For a fully self-operated pool,"
  yellow "        run 'make deploy-testnet' to deploy your own."
fi

# ── 3. dapp/.env.local ─────────────────────────────────────────────────────
hdr "3/5  Config: dapp"
if [ -f "$ROOT/dapp/.env.local" ]; then
  green "  ✓ dapp/.env.local already exists (kept as-is)"
else
  cp "$ADDR" "$ROOT/dapp/.env.local"
  green "  ✓ wrote dapp/.env.local"
fi

# ── 4. install deps ────────────────────────────────────────────────────────
hdr "4/5  Installing dependencies (first run is slow)"
for svc in indexer relayer dapp; do
  yellow "  npm install: $svc…"
  (cd "$ROOT/$svc" && npm install --silent --legacy-peer-deps >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1)
  green "  ✓ $svc deps ready"
done

# ── 5. start everything ────────────────────────────────────────────────────
hdr "5/5  Starting services"
INDEXER_PID=""; RELAYER_PID=""
cleanup() { kill $INDEXER_PID $RELAYER_PID 2>/dev/null || true; }
trap 'cleanup; exit' EXIT INT TERM

(cd "$ROOT/indexer" && npm run dev > /tmp/shield-indexer.log 2>&1) &
INDEXER_PID=$!
(cd "$ROOT/relayer" && npm run dev > /tmp/shield-relayer.log 2>&1) &
RELAYER_PID=$!
sleep 3

green "  ✓ indexer → http://localhost:3001  (log: /tmp/shield-indexer.log)"
green "  ✓ relayer → http://localhost:3002  (log: /tmp/shield-relayer.log)"

echo ""
green "════════════════════════════════════════════════════════"
green "  SHIELD PROTOCOL IS LIVE (testnet)"
green "════════════════════════════════════════════════════════"
echo ""
echo "  Open:     http://localhost:5173"
echo "  Wallet:   Freighter extension, set to TESTNET"
echo "  Funds:    get testnet XLM from https://friendbot.stellar.org"
echo ""
echo "  Press Ctrl-C to stop everything."
echo ""

cd "$ROOT/dapp"
exec npm run dev
