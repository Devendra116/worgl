#!/usr/bin/env bash
# Runs everything: Python reference maths check, Rust unit/property tests, wasm build, sandbox tests.
#   scripts/test.sh          fast run (~5 min)
#   scripts/test.sh --slow   also the sandbox test that crosses a UTC midnight (~20 min)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1/4 python reference maths"
python3 -I sim/worgl_math.py
python3 -I sim/gen_vectors.py

echo "== 2/4 contract unit + property tests (100k-step fuzz included)"
(cd contract && cargo test)

echo "== 3/4 build wasm"
scripts/build.sh

cleanup_sandbox() {  # docker route only: stop leftover sandbox containers (matched by their exact command)
  command -v docker >/dev/null || return 0
  docker ps --no-trunc --format '{{.ID}} {{.Command}}' 2>/dev/null | grep '/neard/near-sandbox' | awk '{print $1}' | xargs -r docker stop >/dev/null 2>&1 || true
}
trap cleanup_sandbox EXIT
echo "== 4/4 sandbox tests (near-workspaces): token flow + Sputnik DAO governance"
source scripts/sandbox-env.sh
scripts/fetch-sputnik-wasm.sh
cd sandbox-tests
if [ "${1:-}" = "--slow" ]; then
  cargo test -- --include-ignored --nocapture
else
  cargo test
fi
if command -v node >/dev/null; then
  echo "== web page maths (JS vs the contract's vectors; add TOKEN=<account> for a live read-only check)"
  node "$ROOT/web/test.mjs"
else
  echo "== skipping web maths test (node not installed)"
fi

echo "ALL TESTS PASSED"
