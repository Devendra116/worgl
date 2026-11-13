#!/usr/bin/env bash
# Read-only check of a deployed Worgl token: re-derives the numbers and prints PASS/FAIL.
# Usage: scripts/verify-testnet.sh <token-account> [<holder-account> ...]
# Sends no transactions and needs no keys (public RPC views only).
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <token-account> [<holder> ...]" >&2; exit 2; }
TOKEN="$1"; shift
RPC="${NEAR_TESTNET_RPC:-https://rpc.testnet.fastnear.com}"
exec python3 -I - "$RPC" "$TOKEN" "$@" <<'PY'
import sys, json, base64, urllib.request
rpc, token, holders = sys.argv[1], sys.argv[2], sys.argv[3:]
def rpc_call(method, params):
    req = urllib.request.Request(rpc, json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
                                 {"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))
# Pin every view to ONE block, so balances cannot decay between calls.
BLOCK = rpc_call("block", {"finality":"final"})["result"]["header"]["height"]
def view(method, args=None):
    body = {"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function",
        "block_id":BLOCK,"account_id":token,"method_name":method,
        "args_base64":base64.b64encode(json.dumps(args or {}).encode()).decode()}}
    req = urllib.request.Request(rpc, json.dumps(body).encode(), {"Content-Type":"application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in r or "error" in r.get("result", {}):
        raise SystemExit(f"{method} failed: {r.get('error') or r['result']['error']}")
    return json.loads(bytes(r["result"]["result"]))
RAY, ONE, SUPPLY = 10**27, 10**18, 1_000_000 * 10**18
bad = 0
def check(name, ok, detail=""):
    global bad
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))
    bad += (not ok)
def mul_div_floor(a,b,c): return a*b//c
def mul_div_ceil(a,b,c): return -((-a*b)//c)
def rpow(x, n):
    r = RAY
    while n:
        if n & 1: r = r*x//RAY
        x = x*x//RAY; n >>= 1
    return r

p, s = view("get_params"), view("get_stats")
print(f"(all views pinned to block {BLOCK})")
print("params:", json.dumps(p)); print("stats: ", json.dumps(s))
factor, start = int(p["factor"]), int(p["start_ns"])
now = int(s["block_timestamp_ns"])
idx = rpow(factor, max(0, now - start) // 10**9)
total_shares = int(s["total_shares"])
treasury, circ = int(s["treasury"]), int(s["circulating"])

check("index matches independent rpow()", int(s["index"]) == idx, f"{s['index']}")
check("circulating = ceil(total_shares*index/RAY)", circ == mul_div_ceil(total_shares, idx, RAY))
check("treasury + circulating = 1,000,000 coins", treasury + circ == SUPPLY, f"{(treasury+circ)/ONE:,.6f}")
check("ft_total_supply = 1,000,000 coins", int(view("ft_total_supply")) == SUPPLY)
check("ft_balance_of(token account) = treasury (same block: exact)",
      int(view("ft_balance_of", {"account_id": token})) == treasury)
check("governor is set", bool(p.get("governor")), p.get("governor"))
check("daily cap = 10% of day-start treasury", int(s["day_cap"]) == int(s["day_start_treasury"]) * int(p["daily_cap_bps"]) // 10000,
      f"cap {int(s['day_cap'])/ONE:,.2f}, paid {int(s['day_paid'])/ONE:,.2f}")
check("day_paid <= day_cap", int(s["day_paid"]) <= int(s["day_cap"]))
check("day_remaining = cap - paid", int(s["day_remaining"]) == max(0, int(s["day_cap"]) - int(s["day_paid"])))

sh_sum = 0
for h in holders:
    a = view("get_account", {"account_id": h})
    if not a: print(f"----  {h}: not registered"); continue
    sh = int(a["shares"]); sh_sum += sh
    bal = int(view("ft_balance_of", {"account_id": h}))
    check(f"{h}: balance = floor(shares*index/RAY)", bal == mul_div_floor(sh, idx, RAY) == int(a["balance"]),
          f"{bal/ONE:,.6f} coins")
if holders:
    check("listed holders' balances <= circulating", mul_div_floor(sh_sum, idx, RAY) <= circ)
print("\nALL CHECKS PASSED" if not bad else f"\n{bad} CHECK(S) FAILED")
sys.exit(1 if bad else 0)
PY
