#!/usr/bin/env bash
# Downloads the exact Sputnik DAO contract that the testnet factory (sputnikv2.testnet) deploys,
# straight from the factory (read-only RPC view `get_code`), and verifies it against the
# factory's default code hash. Used only by the sandbox test of the DAO flow.
# No credentials, account names or project data are sent: it is a public read-only call.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.sandbox/sputnik/sputnikdao2-testnet.wasm"
RPC="${NEAR_TESTNET_RPC:-https://rpc.testnet.fastnear.com}"
FACTORY="sputnikv2.testnet"
[ -s "$OUT" ] && { echo "already present: $OUT"; exit 0; }
mkdir -p "$(dirname "$OUT")"
python3 - "$RPC" "$FACTORY" "$OUT" <<'PY'
import sys, json, base64, hashlib, urllib.request
rpc, factory, out = sys.argv[1:4]
def view(method, args):
    body = {"jsonrpc": "2.0", "id": "x", "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": factory,
        "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}}
    req = urllib.request.Request(rpc, json.dumps(body).encode(), {"content-type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    res = r.get("result", {}).get("result")
    if not res:
        sys.exit(f"RPC view {method} failed: {str(r)[:300]}")
    return bytes(res)
want = json.loads(view("get_default_code_hash", {}))
code = view("get_code", {"code_hash": want})
d = hashlib.sha256(code).digest()
alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(d, "big"); got = ""
while n:
    n, r_ = divmod(n, 58); got = alpha[r_] + got
if got != want:
    sys.exit(f"hash mismatch: factory says {want}, downloaded code hashes to {got}")
open(out, "wb").write(code)
print(f"ok: {len(code)} bytes, code hash {got} -> {out}")
PY
