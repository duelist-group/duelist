#!/usr/bin/env bash
# deploy.sh
# Master orchestrator — runs prereqs, build, deploy, dapp.
#
# Usage:
#   bash deploy/scripts/deploy.sh         # full chain
#   bash deploy/scripts/deploy.sh --skip-prereqs
#   bash deploy/scripts/deploy.sh --skip-deploy
#
# Idempotent: re-running any step is safe.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_PREREQS=0
SKIP_BUILD=0
SKIP_DEPLOY=0
SKIP_DAPP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-prereqs) SKIP_PREREQS=1; shift;;
    --skip-build)   SKIP_BUILD=1; shift;;
    --skip-deploy)  SKIP_DEPLOY=1; shift;;
    --skip-dapp)    SKIP_DAPP=1; shift;;
    *) echo "Unknown flag: $1"; exit 1;;
  esac
done

[ "$SKIP_PREREQS" = "0" ] && bash "$DIR/00-prereqs.sh"
[ "$SKIP_BUILD"   = "0" ] && bash "$DIR/01-build.sh"
[ "$SKIP_DEPLOY"  = "0" ] && bash "$DIR/02-deploy.sh"
[ "$SKIP_DAPP"    = "0" ] && bash "$DIR/03-run-dapp.sh"
