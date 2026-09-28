#!/bin/sh
# Builds the bbvm driver into the given output path and ad-hoc signs it with the
# Virtualization entitlement. No Apple Developer account is involved.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:?output path}
mkdir -p "$(dirname -- "$out")"
xcrun swiftc -swift-version 5 -O -framework Virtualization -framework AppKit -o "$out" "$here/bbvm.swift"
codesign --force --sign - --entitlements "$here/bbvm.entitlements" "$out"
codesign -d --entitlements - "$out" 2>&1 | grep -q 'com.apple.security.virtualization'
shasum -a 256 "$here/bbvm.swift" "$out"
