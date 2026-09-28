#!/bin/sh
# Compile the actual native target and run lifecycle tests with synthetic children.
# No app launch, credentials, installation, signing, or publication.
set -eu
[ "$(uname -s)" = Darwin ] || { echo "Native checks require macOS" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
sh desktop/build-resources.sh --bun-only
cargo build --locked --manifest-path desktop/src-tauri/Cargo.toml --bins
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/support/native-smoke -p 'test_*.py'
