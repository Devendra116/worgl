#!/usr/bin/env bash
# Stand-in for the `near-sandbox` binary on hosts whose glibc is older than 2.39.
# near-workspaces runs it via NEAR_SANDBOX_BIN_PATH; it forwards all arguments to the real
# binary ($NEARD_REAL) running inside an Ubuntu 24.04 container on the host network.
# See scripts/test.sh (which sets everything up) and the README.
set -euo pipefail
: "${NEARD_REAL:?set NEARD_REAL to the real near-sandbox binary}"
TMP="${TMPDIR:-/tmp}"
exec docker run --rm -i --init --network host --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -v "$TMP:$TMP" -v "$(dirname "$NEARD_REAL"):/neard:ro" \
  ubuntu:24.04 "/neard/$(basename "$NEARD_REAL")" "$@"
