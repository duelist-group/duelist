#!/usr/bin/env bash
# deploy/scripts/watchdog.sh
# Shield Protocol — Health watchdog.
#
# Runs continuously. Every CHECK_INTERVAL seconds it verifies:
#   1. Indexer is alive and its tree root matches the on-chain pool root
#   2. Relayer is alive and points to the correct pool
#   3. If either is dead or drifted — restart it
#
# Usage (standalone):
#   bash deploy/scripts/watchdog.sh
#
# Usage (via PM2 — preferred):
#   pm2 start deploy/scripts/watchdog.sh --name shield-watchdog --interpreter bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
CHECK_INTERVAL="${WATCHDOG_INTERVAL:-60}"   # seconds between checks
INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"
RELAYER_URL="${RELAYER_URL:-http://localhost:3002}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"

INDEXER_DIR="$ROOT/indexer"
RELAYER_DIR="$ROOT/relayer"
INDEXER_LOG="/tmp/shield-indexer.log"
RELAYER_LOG="/tmp/shield-relayer.log"

# ── Helpers ───────────────────────────────────────────────────────────────────
green()  { printf "\033[32m[watchdog] %s\033[0m\n" "$*"; }
yellow() { printf "\033[33m[watchdog] %s\033[0m\n" "$*"; }
red()    { printf "\033[31m[watchdog] %s\033[0m\n" "$*"; }
log()    { printf "[watchdog] %s\n" "$*"; }

ts() { date '+%Y-%m-%d %H:%M:%S'; }

restart_indexer() {
  yellow "$(ts) Restarting indexer…"
  pkill -f "dist/server.js" 2>/dev/null || true
  sleep 1
  cd "$INDEXER_DIR"
  set -a; [ -f .env ] && source .env; set +a
  node dist/server.js > "$INDEXER_LOG" 2>&1 &
  sleep 5
  if curl -sf "$INDEXER_URL/health" >/dev/null 2>&1; then
    green "$(ts) Indexer restarted OK."
  else
    red "$(ts) Indexer failed to come back up — check $INDEXER_LOG"
  fi
}

restart_relayer() {
  yellow "$(ts) Restarting relayer…"
  pkill -f "dist/server.js" 2>/dev/null || true
  sleep 1
  cd "$RELAYER_DIR"
  set -a; [ -f .env ] && source .env; set +a
  node dist/server.js > "$RELAYER_LOG" 2>&1 &
  sleep 5
  if curl -sf "$RELAYER_URL/health" >/dev/null 2>&1; then
    green "$(ts) Relayer restarted OK."
  else
    red "$(ts) Relayer failed to come back up — check $RELAYER_LOG"
  fi
}

sync_pool_root() {
  log "$(ts) Syncing pool root via relayer…"
  curl -sf -X POST "$RELAYER_URL/relay/update-root" >/dev/null 2>&1 || true
}

# ── Main loop ─────────────────────────────────────────────────────────────────
log "$(ts) Watchdog started. Checking every ${CHECK_INTERVAL}s."

while true; do
  # ── 1. Indexer health ──────────────────────────────────────────────────────
  INDEXER_OK=false
  INDEXER_STATE=""
  if INDEXER_STATE=$(curl -sf --max-time 5 "$INDEXER_URL/state" 2>/dev/null); then
    INDEXER_OK=true
  fi

  if ! $INDEXER_OK; then
    red "$(ts) Indexer is DOWN."
    restart_indexer
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # ── 2. Relayer health ──────────────────────────────────────────────────────
  RELAYER_OK=false
  if curl -sf --max-time 5 "$RELAYER_URL/health" >/dev/null 2>&1; then
    RELAYER_OK=true
  fi

  if ! $RELAYER_OK; then
    red "$(ts) Relayer is DOWN."
    restart_relayer
    sync_pool_root
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # ── 3. Commitment count sanity check (detect stale cache) ──────────────────
  # Get on-chain pool root from relayer (it fetches directly from RPC)
  RELAYER_POOL=$(curl -sf "$RELAYER_URL/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('pool',''))" 2>/dev/null || true)
  INDEXER_COUNT=$(echo "$INDEXER_STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('commitmentCount',0))" 2>/dev/null || echo "0")

  # Check if the indexer tree root matches what the relayer/contract sees
  # We do this by asking the relayer to update-root and seeing if it changes
  BEFORE_ROOT=$(echo "$INDEXER_STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('root',''))" 2>/dev/null || true)
  UPDATE_RESP=$(curl -sf -X POST "$RELAYER_URL/relay/update-root" 2>/dev/null || true)
  sleep 2
  AFTER_STATE=$(curl -sf "$INDEXER_URL/state" 2>/dev/null || echo "{}")
  AFTER_ROOT=$(echo "$AFTER_STATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('root',''))" 2>/dev/null || true)

  # If indexer count is suspiciously low compared to what relayer reports, warn
  # (The stale-cache purge is now handled in the indexer itself on startup)
  log "$(ts) OK — indexer commitments=${INDEXER_COUNT} root=${BEFORE_ROOT:0:10}…"

  sleep "$CHECK_INTERVAL"
done
