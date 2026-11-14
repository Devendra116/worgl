#!/usr/bin/env bash
# Deploy the WORGL token to TESTNET with the demo decay factor (1% per hour).
#   scripts/deploy-testnet.sh <token-account-id> <governor-account-id>
# The token account must already exist and its key must be in your near-cli keychain, e.g.
#   near account create-account sponsor-by-faucet-service worgl.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
# The governor is the DAO from scripts/create-dao.sh (or any account) and can ONLY call pay_out.
# DRY_RUN=1 prints the commands without running them.
source "$(dirname "$0")/_lib.sh"
[ $# -eq 2 ] || { sed -n '2,8p' "$0"; exit 1; }
TOKEN="$1"; GOVERNOR="$2"
check_testnet_id "$TOKEN"; check_testnet_id "$GOVERNOR"
[ "$TOKEN" != "$GOVERNOR" ] || { echo "governor must differ from the token account"; exit 1; }
need_near
[ -f "$WASM" ] || "$ROOT/scripts/build.sh"

# Demo factor, computed from the Python reference maths (0.99^(1/3600) in RAY=10^27).
FACTOR="$(py 'import sys; sys.path.insert(0, sys.argv[1]); import worgl_math as m; print(m.FACTOR_DEMO)' "$ROOT/sim")"
echo "token:    $TOKEN"; echo "governor: $GOVERNOR"; echo "factor:   $FACTOR (1% per hour)"
echo "wasm:     $(sha256sum "$WASM" | cut -c1-16)...  $WASM"

run near contract deploy "$TOKEN" use-file "$WASM" \
  with-init-call new json-args "{\"factor\":\"$FACTOR\",\"governor\":\"$GOVERNOR\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-keychain send

echo; echo "== Check it (read-only):"
run near contract call-function as-read-only "$TOKEN" get_params json-args '{}' network-config "$NETWORK" now
run near contract call-function as-read-only "$TOKEN" get_stats json-args '{}' network-config "$NETWORK" now
cat <<TXT

== Optional, IRREVERSIBLE, run it only when you are done testing:
The token has no admin or upgrade method, but the account still holds the full-access key you
deployed with, which could redeploy different code. To make the deployed code final, delete the keys:
  near account list-keys $TOKEN network-config $NETWORK now
  near account delete-keys $TOKEN public-keys ed25519:<KEY> network-config $NETWORK sign-with-keychain send
(After that nobody can ever change or remove the contract, and the account's NEAR balance is stuck.)
TXT
