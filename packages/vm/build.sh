#!/bin/sh
# bun run vm:build: the helper, ad-hoc signed with the one entitlement it
# needs. macOS only. The app's bundler signs its own copy (plan, Phase 3a).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
swift build -c release --package-path "$HERE"
BIN=$(swift build -c release --package-path "$HERE" --show-bin-path)/bigbrain-vm
codesign -f -s - --entitlements "$HERE/vm.entitlements" "$BIN"
echo "$BIN"
