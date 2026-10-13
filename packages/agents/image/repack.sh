#!/bin/bash
# Rebuild only the initramfs of an image (a new guest agent), keeping its
# kernel, modules and rootfs: the protocol-change path of the plan's
# "Versioning and release". Runs as anyone.
#   packages/agents/image/repack.sh [image-dir]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
OUT=$(realpath "${1:-$HERE/out}")
case "$(uname -m)" in x86_64) TRIPLE=x86_64-unknown-linux-musl ;; aarch64) TRIPLE=aarch64-unknown-linux-musl ;; esac
cargo build --release --target "$TRIPLE" --manifest-path "$ROOT/packages/guest/Cargo.toml"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && cpio --quiet -id <"$OUT/initramfs.cpio")
install -m 0755 "$ROOT/packages/guest/target/$TRIPLE/release/bigbrain-guest" "$WORK/init"
(cd "$WORK" && find . -mindepth 1 | LC_ALL=C sort | cpio --quiet -o -H newc --owner=0:0 --reproducible) >"$OUT/initramfs.cpio"
echo "initramfs.cpio $(stat -c %s "$OUT/initramfs.cpio") $(sha256sum "$OUT/initramfs.cpio" | cut -d' ' -f1)"
