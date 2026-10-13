#!/bin/sh
# The maintainer's Mac, end to end (the plan's Phase 2): the latest CI
# image for this Mac's architecture, the helper built and signed, the VM
# suite, then the spike. Prints the report and leaves it in
# spike-results.md. About 15 minutes; --quick for about 8.
#
#   bun run vm:spike [--quick] [--run <ci-run-id>]
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
QUICK=""; RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=--quick ;;
    --run) RUN=$2; shift ;;
    *) echo "usage: bun run vm:spike [--quick] [--run <ci-run-id>]" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "vm:spike is for a Mac; on Linux use BIGBRAIN_VM_TESTS=qemu" >&2; exit 1; }
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; esac
IMAGE=$ROOT/packages/agents/image/out

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -z "$RUN" ]; then
  RUN=$(gh run list --workflow machine.yml --branch "$BRANCH" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  [ -n "$RUN" ] || { echo "no successful machine.yml run on $BRANCH yet" >&2; exit 1; }
fi
echo "== image: CI run $RUN, machine-$ARCH"
rm -rf "$IMAGE" && mkdir -p "$IMAGE"
gh run download "$RUN" -n "machine-$ARCH" -D "$IMAGE"
# sparse: gunzip would write all 8 GiB, zeros included
bun packages/agents/src/image.ts "$IMAGE/rootfs.img.gz" "$IMAGE/rootfs.img"
cat "$IMAGE/manifest.txt"

echo "== helper"
sh packages/vm/build.sh

echo "== the VM suite"
BIGBRAIN_VM_TESTS=vz bun test packages/agents/test/machine.test.ts || echo "(the VM suite failed: its output is above; the spike runs anyway)"

echo "== the spike"
bun packages/agents/test/machine.spike.ts $QUICK --out spike-results.md
