# Shared helpers for the testnet scripts (sourced, not run).
# DRY_RUN=1 prints every command and runs nothing.
set -euo pipefail
NETWORK="testnet"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$ROOT/contract/target/near/worgl_token.wasm"

show() {  # print a command copy-paste ready: plain words as-is, everything else single-quoted
  local out="" a
  for a in "$@"; do
    if [[ "$a" =~ ^[A-Za-z0-9_./:=@%+,-]+$ ]]; then out+="$a "; else out+="'${a//\'/\'\\\'\'}' "; fi
  done
  printf '\n$ %s\n' "${out% }"
}
run() {  # print the command exactly as it will run, then run it (unless DRY_RUN=1)
  show "$@"
  [ "${DRY_RUN:-0}" = "1" ] || "$@"
}
need_near() {
  command -v near >/dev/null || [ "${DRY_RUN:-0}" = "1" ] || { echo "near-cli-rs not found: cargo install near-cli-rs --locked"; exit 1; }
}
check_testnet_id() {  # $1 = account id
  [[ "$1" =~ ^[a-z0-9._-]+\.testnet$ ]] || { echo "not a testnet account id: $1"; exit 1; }
}
py() { python3 -I -c "$@"; }  # py CODE ARGS... (sys.argv[1:] = ARGS)
