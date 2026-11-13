# Sourced by test.sh. Makes near-workspaces able to start a local sandbox node.
# The current `neard` sandbox build needs glibc >= 2.39 (Ubuntu 24.04+). On older hosts we run the
# same binary inside an ubuntu:24.04 container (needs docker) via scripts/neard-docker-wrapper.sh.
SANDBOX_VERSION="2.14.1"   # = near-sandbox crate default used by near-workspaces 0.24
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_glibc="$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0.0)"
if [ "$(printf '%s\n2.39\n' "$_glibc" | sort -V | head -1)" = "2.39" ]; then
  echo "glibc $_glibc: running the sandbox natively"
else
  command -v docker >/dev/null || { echo "glibc $_glibc < 2.39 and docker not found: cannot start the sandbox"; return 1; }
  _dir="$_root/.sandbox/$SANDBOX_VERSION"
  if [ ! -x "$_dir/near-sandbox" ]; then
    echo "glibc $_glibc < 2.39: downloading neard sandbox $SANDBOX_VERSION and running it in docker"
    mkdir -p "$_dir"
    curl -fsSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/$SANDBOX_VERSION/near-sandbox.tar.gz" | tar xz -C "$_dir" --strip-components=1
  fi
  export NEARD_REAL="$_dir/near-sandbox"
  export NEAR_SANDBOX_BIN_PATH="$_root/scripts/neard-docker-wrapper.sh"
fi
