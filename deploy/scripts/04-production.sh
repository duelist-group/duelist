#!/usr/bin/env bash
# deploy/scripts/04-production.sh
# Build and start production services with PM2.
#
# Run AFTER 01-build.sh and 02-deploy.sh.
# Usage: POOL_CONTRACT=C... RELAYER_SECRET=S... bash 04-production.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }

if [ -z "${POOL_CONTRACT:-}" ]; then
  # Try loading from addresses env
  if [ -f "$ROOT/deploy/addresses.testnet.env" ]; then
    source "$ROOT/deploy/addresses.testnet.env"
  fi
fi

if [ -z "${POOL_CONTRACT:-}" ]; then
  red "POOL_CONTRACT not set. Run 02-deploy.sh first or export it."
  exit 1
fi

echo "============================================"
echo "Shield Protocol — Production Deploy"
echo "============================================"

# ── 1. Build services ──
yellow "[1/4] Building indexer…"
cd "$ROOT/indexer"
npm install --production 2>/dev/null || yarn install --production
npx tsc -p tsconfig.json
green "✓ Indexer built."

yellow "[2/4] Building relayer…"
cd "$ROOT/relayer"
npm install --production 2>/dev/null || yarn install --production
npx tsc -p tsconfig.json
green "✓ Relayer built."

# ── 2. Build dapp ──
yellow "[3/4] Building dapp for production…"
cd "$ROOT/dapp"
npm install 2>/dev/null || yarn install
VITE_POOL_CONTRACT="$VITE_POOL_CONTRACT" \
VITE_INDEXER_URL="${VITE_INDEXER_URL:-https://indexer.yourdomain.com}" \
npm run build
green "✓ DApp built to dapp/dist/"

# ── 3. Start with PM2 ──
yellow "[4/4] Starting services with PM2…"
cd "$ROOT"
mkdir -p logs

if ! command -v pm2 >/dev/null 2>&1; then
  yellow "Installing PM2…"
  npm install -g pm2
fi

# Export environment to PM2
export POOL_CONTRACT
export RELAYER_SECRET="${RELAYER_SECRET:-}"
export ATTESTATION_SECRET="${ATTESTATION_SECRET:-}"
export OFAC_API_URL="${OFAC_API_URL:-}"
export RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"

pm2 start ecosystem.config.cjs --env production
pm2 save

echo ""
echo "============================================"
green "Production services started!"
echo ""
echo "Indexer:  http://localhost:3001"
echo "Relayer:  http://localhost:3002"
echo "DApp:     serve dapp/dist/ with Nginx or Vercel"
echo ""
echo "Useful commands:"
echo "  pm2 logs          — stream all logs"
echo "  pm2 monit         — visual dashboard"
echo "  pm2 restart all   — restart all services"
echo ""
echo "Next: configure Nginx (deploy/nginx/shield-protocol.conf)"
echo "      and update VITE_INDEXER_URL in your dapp .env"
echo "============================================"
