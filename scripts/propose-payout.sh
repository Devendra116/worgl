#!/usr/bin/env bash
# Propose a treasury payout through the DAO and cast the proposer's approval.
#   scripts/propose-payout.sh <dao> <token> <recipient> <amount-in-coins> <council-member> [<second-council-member>]
# Adds a FunctionCall proposal "token.pay_out(recipient, amount, memo)" (0.1 NEAR proposal bond),
# then act_proposal VoteApprove by <council-member>. The policy needs TWO approvals: pass a second
# council member to approve too (the second approval executes the payout), or run the printed
# command as that member. The recipient must already be registered on the token (claimed or
# storage_deposit). The daily cap (10% of the treasury at the start of the UTC day) still applies.
# DRY_RUN=1 prints the commands without running them (the proposal id is then shown as $PROPOSAL_ID).
source "$(dirname "$0")/_lib.sh"
[ $# -ge 5 ] && [ $# -le 6 ] || { sed -n '2,11p' "$0"; exit 1; }
DAO="$1"; TOKEN="$2"; RECIPIENT="$3"; COINS="$4"; PROPOSER="$5"; VOTER2="${6:-}"
for a in "$DAO" "$TOKEN" "$RECIPIENT" "$PROPOSER"; do check_testnet_id "$a"; done
[ -z "$VOTER2" ] || check_testnet_id "$VOTER2"
need_near

# amount in coins (18 decimals) -> base units, exact
AMOUNT="$(py '
import sys
from decimal import Decimal, InvalidOperation
try:
    d = Decimal(sys.argv[1])
except InvalidOperation:
    sys.exit("amount is not a number")
u = d * 10**18
if d <= 0 or u != u.to_integral_value():
    sys.exit("amount must be > 0 with at most 18 decimals")
print(int(u))' "$COINS")"

# pay_out args and the proposal kind (the same JSON is sent to add_proposal and act_proposal)
read -r KIND < <(py '
import sys, json, base64
token, recipient, amount = sys.argv[1:4]
args = {"recipient": recipient, "amount": amount, "memo": "dao-proposal"}
kind = {"FunctionCall": {"receiver_id": token, "actions": [{
    "method_name": "pay_out",
    "args": base64.b64encode(json.dumps(args, separators=(",", ":")).encode()).decode(),
    "deposit": "0", "gas": "30000000000000"}]}}
print(json.dumps(kind, separators=(",", ":")))' "$TOKEN" "$RECIPIENT" "$AMOUNT")
DESC="WORGL payout: $COINS coins to $RECIPIENT"

run near contract call-function as-transaction "$DAO" add_proposal \
  json-args "{\"proposal\":{\"description\":\"$DESC\",\"kind\":$KIND}}" \
  prepaid-gas '100 Tgas' attached-deposit '0.1 NEAR' \
  sign-as "$PROPOSER" network-config "$NETWORK" sign-with-keychain send

# get_last_proposal_id returns the NEXT id, so the proposal just added is that minus one.
if [ "${DRY_RUN:-0}" = "1" ]; then
  PROPOSAL_ID='$PROPOSAL_ID'
else
  LAST="$(near --quiet contract call-function as-read-only "$DAO" get_last_proposal_id json-args '{}' network-config "$NETWORK" now | grep -oE '[0-9]+' | tail -1)"
  [ -n "$LAST" ] || { echo "could not read the proposal id; look it up with: near contract call-function as-read-only $DAO get_last_proposal_id json-args '{}' network-config $NETWORK now"; exit 1; }
  PROPOSAL_ID=$((LAST - 1))
  echo "proposal id: $PROPOSAL_ID"
fi

vote() {  # $1 = council member
  run near contract call-function as-transaction "$DAO" act_proposal \
    json-args "{\"id\":$PROPOSAL_ID,\"action\":\"VoteApprove\",\"proposal\":$KIND}" \
    prepaid-gas '200 Tgas' attached-deposit '0 NEAR' \
    sign-as "$1" network-config "$NETWORK" sign-with-keychain send
}
vote "$PROPOSER"
if [ -n "$VOTER2" ]; then
  vote "$VOTER2"
  echo; echo "== Check the proposal and the balance:"
  run near contract call-function as-read-only "$DAO" get_proposal json-args "{\"id\":$PROPOSAL_ID}" network-config "$NETWORK" now
  run near contract call-function as-read-only "$TOKEN" ft_balance_of json-args "{\"account_id\":\"$RECIPIENT\"}" network-config "$NETWORK" now
else
  cat <<TXT

One approval is recorded; the policy needs two. A second council member approves with:
  near contract call-function as-transaction $DAO act_proposal json-args '{"id":$PROPOSAL_ID,"action":"VoteApprove","proposal":$KIND}' prepaid-gas '200 Tgas' attached-deposit '0 NEAR' sign-as <SECOND-MEMBER>.testnet network-config $NETWORK sign-with-keychain send
TXT
fi
