#!/usr/bin/env bash
# Create a Sputnik DAO on TESTNET through the factory sputnikv2.testnet:
# a council of three accounts; a proposal passes with TWO approvals; only the council can propose.
#   scripts/create-dao.sh <dao-name> <signer> <council-1> <council-2> <council-3>
# The DAO account becomes <dao-name>.sputnikv2.testnet (use it as the token's governor).
# <signer> pays the 6 NEAR factory deposit and needs its key in your near-cli keychain.
# DRY_RUN=1 prints the command without running it.
source "$(dirname "$0")/_lib.sh"
[ $# -eq 5 ] || { sed -n '2,9p' "$0"; exit 1; }
NAME="$1"; SIGNER="$2"; C1="$3"; C2="$4"; C3="$5"
[[ "$NAME" =~ ^[a-z0-9_-]+$ ]] || { echo "dao-name: lowercase letters, digits, - or _"; exit 1; }
for a in "$SIGNER" "$C1" "$C2" "$C3"; do check_testnet_id "$a"; done
[ "$(printf '%s\n' "$C1" "$C2" "$C3" | sort -u | wc -l)" = 3 ] || { echo "the three council accounts must be different"; exit 1; }
need_near

# `args` of the factory's create() is the base64 of the DAO's `new` arguments (config + policy).
ARGS_B64="$(py '
import json, base64, sys
name, c1, c2, c3 = sys.argv[1:5]
new_args = {
  "config": {"name": name, "purpose": "Governs WORGL treasury payouts", "metadata": ""},
  "policy": {
    "roles": [{"name": "council", "kind": {"Group": [c1, c2, c3]},
               "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
               "vote_policy": {}}],
    # RoleWeight: each council member weighs 1, so threshold "2" means exactly two approvals.
    "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "2"},
    "proposal_bond": "100000000000000000000000",   # 0.1 NEAR
    "proposal_period": "604800000000000",          # 7 days (ns)
    "bounty_bond": "100000000000000000000000",
    "bounty_forgiveness_period": "86400000000000"
  }}
print(base64.b64encode(json.dumps(new_args, separators=(",", ":")).encode()).decode())
' "$NAME" "$C1" "$C2" "$C3")"

DAO="$NAME.sputnikv2.testnet"
echo "DAO account: $DAO   council: $C1 $C2 $C3   approvals needed: 2"
run near contract call-function as-transaction sputnikv2.testnet create \
  json-args "{\"name\":\"$NAME\",\"args\":\"$ARGS_B64\"}" \
  prepaid-gas '150 Tgas' attached-deposit '6 NEAR' \
  sign-as "$SIGNER" network-config "$NETWORK" sign-with-keychain send

echo; echo "== Check it (read-only):"
run near contract call-function as-read-only "$DAO" get_policy json-args '{}' network-config "$NETWORK" now
echo; echo "Next: scripts/deploy-testnet.sh <token-account> $DAO"
