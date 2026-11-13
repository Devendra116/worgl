#!/usr/bin/env bash
# Build the token contract to contract/target/near/worgl_token.wasm with cargo-near
# (cargo-near applies the wasm settings the NEAR runtime accepts; a plain `cargo build` is not enough).
set -euo pipefail
cd "$(dirname "$0")/../contract"
command -v cargo-near >/dev/null || { echo "cargo-near not found. Install: cargo install cargo-near --locked (needs libudev-dev, pkg-config)"; exit 1; }
cargo near build non-reproducible-wasm
echo
sha256sum target/near/worgl_token.wasm
