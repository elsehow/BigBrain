#!/bin/sh
# build-resources.sh — assemble what the desktop app bundles (#573):
#
#   src-tauri/binaries/bun-<target-triple>   the sidecar: bun itself, the
#                                            runtime that runs the engine
#   src-tauri/binaries/llama-server-<triple> the firewall's model server
#                                            (build-llama-server.sh)
#   src-tauri/resources/engine/              the engine tree the sidecar runs
#                                            (bin/ lib/ integrations/ prompts/
#                                            deploy/ clients/ packages/ web/ui/dist/
#                                            + production node_modules)
#
# The engine spawns every job as `process.execPath <ENGINE_ROOT>/bin/x.ts`
# and reads its templates from ENGINE_ROOT (lib/engine.ts resolves it from
# the file's own location), so a copied tree behaves exactly like a checkout.
# No `bun build --compile`: subprocesses (tend, publish, integrations)
# keep working unchanged.
#
#   sh build-resources.sh             everything (what `tauri build` runs)
#   sh build-resources.sh --bun-only  just the sidecars, for `tauri dev`
set -eu
here=$(cd "$(dirname "$0")" && pwd)
engine=$(cd "$here/.." && pwd)
triple=${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}
bun=$(command -v bun)

echo "resources: engine $engine → $here/src-tauri/resources/engine (triple $triple)"

mkdir -p "$here/src-tauri/binaries" "$here/src-tauri/resources"
rm -f "$here/src-tauri/binaries/bun-$triple" # the previous copy kept bun's read-only mode
cp "$bun" "$here/src-tauri/binaries/bun-$triple"
# 755, not just +x: bun ships itself read-only, and the bundler's signing
# step (`xattr -cr` on the bundle, then codesign) needs to write it
chmod 755 "$here/src-tauri/binaries/bun-$triple"

sh "$here/build-llama-server.sh"

dest="$here/src-tauri/resources/engine"
if [ "${1:-}" = "--bun-only" ]; then
  # The dev loop (dev.sh) runs the engine from the checkout (BIGBRAIN_ENGINE), so
  # the bundled copy is not needed — but tauri-build insists the resource
  # path exists. Leave a stub, or whatever a previous full build left.
  mkdir -p "$dest"
  [ -e "$dest/BUNDLE" ] || printf 'stub — dev.sh runs the engine from BIGBRAIN_ENGINE; `sh build-resources.sh` fills this in\n' > "$dest/BUNDLE"
  exit 0
fi
# The viewer is BUILT here, never trusted from disk: a release cut with a
# stale web/ui/dist shipped a months-old UI inside a current shell once
# (0.1.8, 2026-08-28 — no themes, a dead #/palette), and nothing in the
# app can tell. ~1s, and the shipped viewer is now always the sources
# beside it.
[ -d "$engine/web/ui/node_modules" ] || { echo "resources: web/ui/node_modules missing — run \`bun install\` in $engine/web/ui first" >&2; exit 1; }
( cd "$engine" && bun run web:build )

rm -rf "$dest"
mkdir -p "$dest"
# What the engine RUNS, and nothing else. The excludes are relative to each
# source directory, not to the engine root — `web/ui/node_modules` and
# `web/ui/dev.html` never matched anything from here, which is how the
# viewer's 668K of TypeScript sources and the 692K browser extension ended
# up inside the app. Nothing in the bundle runs either one: the viewer is
# served from web/ui/dist, and the extension ships from the site.
for d in bin lib integrations prompts deploy clients web packages; do
  rsync -a --delete \
    --exclude node_modules --exclude '.claude' --exclude '*.test.ts' \
    --exclude 'ui/src' --exclude 'ui/dev.html' --exclude 'browser-extension' \
    "$engine/$d" "$dest/"
done
cp "$engine/package.json" "$engine/bun.lock" "$engine/vault.example.yaml" "$engine/.env.example" "$dest/"
# production deps only — the engine's runtime imports (mcp sdk, d3-force,
# typebox, yaml); nothing from devDependencies.
( cd "$dest" && bun install --production --frozen-lockfile >/dev/null 2>&1 || bun install --production >/dev/null )
rm -f "$dest/bun.lock"
printf 'engine %s\nbuilt %s\n' "$(git -C "$engine" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/BUNDLE"
du -sh "$dest" "$here/src-tauri/binaries/bun-$triple" | sed 's/^/resources: /'
