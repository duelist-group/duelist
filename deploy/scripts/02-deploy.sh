#!/usr/bin/env bash
# 02-deploy.sh — Deploy Shield Protocol to Stellar testnet/mainnet
set -euo pipefail
 
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
 
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
 
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
FRIENDBOT_URL="${FRIENDBOT_URL:-https://friendbot.stellar.org}"
DEPLOYER_KEY_NAME="${DEPLOYER_KEY_NAME:-shield-deployer}"
 
WASM_DIR="$ROOT/contracts/wasms"
CIRCUITS_DIR="$ROOT/circuits/target"
ADDRESSES_FILE="$ROOT/deploy/addresses.${NETWORK}.env"
UH_ENGINE_WASM="${UH_ENGINE_WASM:-}"
 
echo "======================================="
echo "Shield Protocol — Deploy to ${NETWORK}"
echo "======================================="
 
stellar network add "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null || true
 
if ! stellar keys ls 2>/dev/null | grep -q "^${DEPLOYER_KEY_NAME}$"; then
  yellow "Generating deployer identity '${DEPLOYER_KEY_NAME}'…"
  stellar keys generate "$DEPLOYER_KEY_NAME" --network "$NETWORK"
else
  green "✓ Deployer identity '${DEPLOYER_KEY_NAME}' exists."
fi
DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER_KEY_NAME")
green "Deployer: $DEPLOYER_ADDR"
 
yellow "Ensuring deployer is funded on ${NETWORK}…"
curl -fsSL "${FRIENDBOT_URL}/?addr=${DEPLOYER_ADDR}" >/dev/null 2>&1 || \
  yellow "(friendbot may have already funded this account; continuing)"
green "✓ Deployer funded."
 
if [ -z "$UH_ENGINE_WASM" ]; then
  red "UH_ENGINE_WASM is not set."
  red "  export UH_ENGINE_WASM=/path/to/ultrahonk_soroban_contract.wasm"
  exit 1
fi
if [ ! -f "$UH_ENGINE_WASM" ]; then
  red "File not found: $UH_ENGINE_WASM"
  exit 1
fi
 
yellow "Uploading verifier WASM…"
VERIFIER_WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm "$WASM_DIR/shield_verifier.wasm" 2>/dev/null | tail -1)
 
yellow "Uploading pool WASM…"
POOL_WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm "$WASM_DIR/shield_pool.wasm" 2>/dev/null | tail -1)
 
yellow "Uploading compliance WASM…"
COMPLIANCE_WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm "$WASM_DIR/shield_compliance.wasm" 2>/dev/null | tail -1)
green "✓ WASMs uploaded."
 
yellow "Uploading UltraHonk engine WASM…"
ENGINE_WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm "$UH_ENGINE_WASM" 2>/dev/null | tail -1)
green "✓ Engine WASM hash: $ENGINE_WASM_HASH"
 
deploy_engine() {
  local circuit="$1"
  local vk_path="$CIRCUITS_DIR/${circuit}_vk/vk"
  if [ ! -f "$vk_path" ]; then
    red "✗ VK missing: $vk_path — run 01-build.sh first" >&2
    exit 1
  fi
  # The engine exposes initialize(vk_bytes) — NOT a __constructor — so the VK
  # must be set in a SEPARATE invoke after deploy. (Passing it as a constructor
  # arg silently no-ops, leaving the engine uninitialized -> verify_proof traps.)
  local engine_id
  engine_id=$(stellar contract deploy \
    --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
    --wasm-hash "$ENGINE_WASM_HASH" 2>/dev/null | tail -1)
  stellar contract invoke \
    --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
    --id "$engine_id" --send=yes \
    -- initialize --vk_bytes-file-path "$vk_path" >/dev/null 2>&1
  echo "$engine_id"
}
 
ENGINE_DEPOSIT=$(deploy_engine deposit)
green "Engine (deposit):  $ENGINE_DEPOSIT"

ENGINE_TRANSFER=$(deploy_engine transfer)
green "Engine (transfer): $ENGINE_TRANSFER"

ENGINE_TRANSFER_BATCH=$(deploy_engine transfer_batch)
green "Engine (transfer_batch): $ENGINE_TRANSFER_BATCH"

ENGINE_WITHDRAW_SMALL=$(deploy_engine withdraw_small)
green "Engine (withdraw_small): $ENGINE_WITHDRAW_SMALL"

ENGINE_WITHDRAW_LARGE=$(deploy_engine withdraw_large)
green "Engine (withdraw_large): $ENGINE_WITHDRAW_LARGE"
 
yellow "Deploying verifier dispatcher…"
VERIFIER_ID=$(stellar contract deploy \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm-hash "$VERIFIER_WASM_HASH" 2>/dev/null | tail -1)
green "Verifier: $VERIFIER_ID"
 
yellow "Deploying pool…"
POOL_ID=$(stellar contract deploy \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm-hash "$POOL_WASM_HASH" 2>/dev/null | tail -1)
green "Pool: $POOL_ID"
 
yellow "Deploying compliance…"
COMPLIANCE_ID=$(stellar contract deploy \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --wasm-hash "$COMPLIANCE_WASM_HASH" 2>/dev/null | tail -1)
green "Compliance: $COMPLIANCE_ID"
 
yellow "Initializing verifier dispatcher…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$VERIFIER_ID" \
  -- initialize \
    --admin "$DEPLOYER_ADDR" \
    --engine_deposit "$ENGINE_DEPOSIT" \
    --engine_transfer "$ENGINE_TRANSFER" \
    --engine_transfer_batch "$ENGINE_TRANSFER_BATCH" \
    --engine_withdraw_small "$ENGINE_WITHDRAW_SMALL" \
    --engine_withdraw_large "$ENGINE_WITHDRAW_LARGE"
green "✓ Verifier initialized."
 
ZERO_HASH="0000000000000000000000000000000000000000000000000000000000000000"
yellow "Initializing pool…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$POOL_ID" \
  -- initialize \
    --admin "$DEPLOYER_ADDR" \
    --verifier_contract "$VERIFIER_ID" \
    --compliance_contract "$COMPLIANCE_ID" \
    --fee_recipient "$DEPLOYER_ADDR" \
    --protocol_fee_bps 25 \
    --initial_blacklist_root "$ZERO_HASH"
green "✓ Pool initialized."

# Set withdraw fee + relay fee minimum (separate from initialize to keep the
# initialize signature stable). relay_fee_min=1_000_000 = 0.1 token units.
yellow "Configuring fee parameters…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$POOL_ID" \
  -- set_fee_bps \
    --caller "$DEPLOYER_ADDR" \
    --protocol_fee_bps 25 \
    --withdraw_fee_bps 25 \
    --relay_fee_min 1000000
green "✓ Fee parameters set (deposit 0.25%, withdraw 0.25%, relay min 0.1 units)."
 
yellow "Initializing compliance…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$COMPLIANCE_ID" \
  -- initialize \
    --admin "$DEPLOYER_ADDR" \
    --pool "$POOL_ID" \
    --signatories "[\"$DEPLOYER_ADDR\"]" \
    --threshold 1 \
    --initial_root "$ZERO_HASH"
green "✓ Compliance initialized."
 
XLM_SAC="${XLM_SAC:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"
XLM_ASSET_ID="0000000000000000000000000000000000000000000000000000000000000001"
yellow "Registering XLM…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$POOL_ID" \
  -- register_asset \
    --caller "$DEPLOYER_ADDR" \
    --asset_id "$XLM_ASSET_ID" \
    --asset_contract "$XLM_SAC" \
    --allowed true
green "✓ XLM registered."
 
if [ "$NETWORK" = "mainnet" ]; then
  USDC_SAC="${USDC_SAC:-CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75}"
  EURC_SAC="${EURC_SAC:-CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV}"
else
  USDC_SAC="${USDC_SAC:-CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7}"
  EURC_SAC="${EURC_SAC:-CC3VUZCA5P7SY4I3NUJTYZAQ54DFZBGA5NRFG76WHAKNGJ6VGWI6FKYE}"
fi
USDC_ASSET_ID="0000000000000000000000000000000000000000000000000000000000000002"
EURC_ASSET_ID="0000000000000000000000000000000000000000000000000000000000000003"
 
yellow "Registering USDC…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$POOL_ID" \
  -- register_asset \
    --caller "$DEPLOYER_ADDR" \
    --asset_id "$USDC_ASSET_ID" \
    --asset_contract "$USDC_SAC" \
    --allowed true
green "✓ USDC registered."
 
yellow "Registering EURC…"
stellar contract invoke \
  --network "$NETWORK" --source "$DEPLOYER_KEY_NAME" \
  --id "$POOL_ID" \
  -- register_asset \
    --caller "$DEPLOYER_ADDR" \
    --asset_id "$EURC_ASSET_ID" \
    --asset_contract "$EURC_SAC" \
    --allowed true
green "✓ EURC registered."
 
{
  echo "# Auto-generated by 02-deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "VITE_NETWORK_NAME=Stellar ${NETWORK^}"
  echo "VITE_RPC_URL=${RPC_URL}"
  echo "VITE_NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE}"
  echo "VITE_POOL_CONTRACT=${POOL_ID}"
  echo "VITE_VERIFIER_CONTRACT=${VERIFIER_ID}"
  echo "VITE_COMPLIANCE_CONTRACT=${COMPLIANCE_ID}"
  echo "VITE_ENGINE_DEPOSIT=${ENGINE_DEPOSIT}"
  echo "VITE_ENGINE_TRANSFER=${ENGINE_TRANSFER}"
  echo "VITE_ENGINE_TRANSFER_BATCH=${ENGINE_TRANSFER_BATCH}"
  echo "VITE_ENGINE_WITHDRAW_SMALL=${ENGINE_WITHDRAW_SMALL}"
  echo "VITE_ENGINE_WITHDRAW_LARGE=${ENGINE_WITHDRAW_LARGE}"
  echo "VITE_XLM_CONTRACT=${XLM_SAC}"
  echo "VITE_XLM_ASSET_ID=0x${XLM_ASSET_ID}"
  echo "VITE_USDC_CONTRACT=${USDC_SAC}"
  echo "VITE_USDC_ASSET_ID=0x${USDC_ASSET_ID}"
  echo "VITE_EURC_CONTRACT=${EURC_SAC}"
  echo "VITE_EURC_ASSET_ID=0x${EURC_ASSET_ID}"
  echo "VITE_INDEXER_URLS=http://localhost:3001"
  echo "VITE_RELAYER_URLS=http://localhost:3002"
} > "$ROOT/dapp/.env.local"
 
cat "$ROOT/dapp/.env.local" > "$ADDRESSES_FILE"

# Update relayer/.env — preserve existing secrets, patch contract addresses only.
RELAYER_ENV="$ROOT/relayer/.env"
if [ -f "$RELAYER_ENV" ]; then
  yellow "Updating relayer/.env contract addresses…"
  sed -i "s|^POOL_CONTRACT=.*|POOL_CONTRACT=${POOL_ID}|" "$RELAYER_ENV"
  sed -i "s|^VERIFIER_CONTRACT=.*|VERIFIER_CONTRACT=${VERIFIER_ID}|" "$RELAYER_ENV"
  sed -i "s|^COMPLIANCE_CONTRACT=.*|COMPLIANCE_CONTRACT=${COMPLIANCE_ID}|" "$RELAYER_ENV"
  sed -i "s|^ENGINE_DEPOSIT=.*|ENGINE_DEPOSIT=${ENGINE_DEPOSIT}|" "$RELAYER_ENV"
  sed -i "s|^ENGINE_TRANSFER=.*|ENGINE_TRANSFER=${ENGINE_TRANSFER}|" "$RELAYER_ENV"
  sed -i "s|^ENGINE_TRANSFER_BATCH=.*|ENGINE_TRANSFER_BATCH=${ENGINE_TRANSFER_BATCH}|" "$RELAYER_ENV"
  sed -i "s|^ENGINE_WITHDRAW_SMALL=.*|ENGINE_WITHDRAW_SMALL=${ENGINE_WITHDRAW_SMALL}|" "$RELAYER_ENV"
  sed -i "s|^ENGINE_WITHDRAW_LARGE=.*|ENGINE_WITHDRAW_LARGE=${ENGINE_WITHDRAW_LARGE}|" "$RELAYER_ENV"
  sed -i "s|^XLM_CONTRACT=.*|XLM_CONTRACT=${XLM_SAC}|" "$RELAYER_ENV"
  sed -i "s|^USDC_CONTRACT=.*|USDC_CONTRACT=${USDC_SAC}|" "$RELAYER_ENV"
  sed -i "s|^EURC_CONTRACT=.*|EURC_CONTRACT=${EURC_SAC}|" "$RELAYER_ENV"
  green "✓ relayer/.env updated."
fi

# Update indexer/.env — preserve existing vars, patch pool address only.
INDEXER_ENV="$ROOT/indexer/.env"
if [ -f "$INDEXER_ENV" ]; then
  yellow "Updating indexer/.env pool address…"
  sed -i "s|^POOL_CONTRACT=.*|POOL_CONTRACT=${POOL_ID}|" "$INDEXER_ENV"
  green "✓ indexer/.env updated."
fi

echo ""
echo "======================================="
green "Deployment complete!"
echo "Pool:              $POOL_ID"
echo "Verifier:          $VERIFIER_ID"
echo "Compliance:        $COMPLIANCE_ID"
echo "Engine (deposit):        $ENGINE_DEPOSIT"
echo "Engine (transfer):       $ENGINE_TRANSFER"
echo "Engine (transfer_batch): $ENGINE_TRANSFER_BATCH"
echo "Engine (withdraw_small): $ENGINE_WITHDRAW_SMALL"
echo "Engine (withdraw_large): $ENGINE_WITHDRAW_LARGE"
echo ""
echo "Addresses → dapp/.env.local"
echo "Next: bash deploy/scripts/03-run-dapp.sh"
echo "======================================="