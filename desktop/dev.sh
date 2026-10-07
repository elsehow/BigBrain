#!/bin/sh
# dev.sh — the live loop. Nothing is installed and nothing is bundled:
#
#   engine   THIS checkout (BIGBRAIN_ENGINE), so a `git pull` or an edit is what runs
#   api/web  under `bun --watch` (BIGBRAIN_DEV): restart themselves on an edit
#   viewer   vite with HMR, proxying /api to the engine's web port
#   shell    `tauri dev`: recompiles and relaunches on a Rust edit
#
# It needs a SCRATCH vault — the /verify rule: never develop against a real
# one. The ports default beside a running install (:4757/:4758/:5173).
#
#   BIGBRAIN_VAULT=~/some-scratch-vault bun run desktop:dev
set -eu
here=$(cd "$(dirname "$0")" && pwd)
engine=$(cd "$here/.." && pwd)
vault=${BIGBRAIN_VAULT:?set BIGBRAIN_VAULT to a scratch vault (never a real one)}
web=${BIGBRAIN_WEB_PORT:-4757}
api=${BIGBRAIN_API_PORT:-4758}
# Any interface, any family: a vite on ::1 is invisible to a 127.0.0.1 probe.
if command -v lsof >/dev/null 2>&1; then
  busy() { [ -n "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ]; }
else
  busy() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" || curl -s -o /dev/null --max-time 1 "http://[::1]:$1/"; }
fi
# The engine ports must be ours: something already answering there would
# make the shell attach to it (a live install, another dev loop) and this
# checkout's engine would never run.
for p in "$web" "$api"; do
  busy "$p" && { echo "dev: :$p is already answering — set BIGBRAIN_WEB_PORT/BIGBRAIN_API_PORT to free ports" >&2; exit 2; }
done
# vite: the first free port from BIGBRAIN_VITE_PORT (default 5173) upward — another
# vite is often running on a dev machine.
vite=${BIGBRAIN_VITE_PORT:-5173}
while busy "$vite"; do vite=$((vite + 1)); done
# A vault that does not exist yet (or an empty folder) is FIRST RUN — the
# supervisor opens the setup door and the app asks for a folder; point it
# at a scratch path to try that. A folder holding other things is refused
# here as it would be there.
if [ -e "$vault" ] && [ ! -f "$vault/vault.yaml" ] && [ -n "$(ls -A "$vault" 2>/dev/null)" ]; then
  echo "dev: $vault holds files and no vault.yaml — a scratch vault, or a path that does not exist yet (first run)" >&2; exit 2
fi
[ -d "$engine/node_modules" ] || { echo "dev: run \`bun install\` in $engine first" >&2; exit 2; }
[ -d "$engine/web/ui/node_modules" ] || { echo "dev: run \`bun install\` in $engine/web/ui first" >&2; exit 2; }
[ -d "$here/node_modules" ] || { echo "dev: run \`bun install\` in $here first (the tauri CLI lives there)" >&2; exit 2; }

sh "$here/build-resources.sh" --bun-only

echo "dev: vite on :$vite → /api on :$web"
# --host 127.0.0.1: vite's default `localhost` can bind ::1 only, which the
# webview URL and the probe below (both 127.0.0.1) would never reach.
( cd "$engine/web/ui" && BIGBRAIN_WEB_PORT=$web bunx vite --host 127.0.0.1 --port "$vite" --strictPort ) &
# On any exit take down the WHOLE process group — vite, tauri, the app, the
# supervisor and its `bun --watch` children — not just vite: a child that
# outlives this script squats the engine ports for the next run.
marker=${TMPDIR:-/tmp}/bigbrain-dev-${web}.json
cleanup() { trap - EXIT INT TERM; rm -f "$marker"; kill 0 2>/dev/null; }
trap cleanup EXIT INT TERM
until curl -sf -o /dev/null "http://127.0.0.1:$vite/"; do sleep 0.3; done

printf '{"pid":%s,"engine":%s,"vault":%s,"web":%s,"api":%s,"vite":%s}\n' \
  "$$" "\"$engine\"" "\"$vault\"" "$web" "$api" "$vite" > "$marker"
echo "dev: engine $engine; vault $vault; web :$web api :$api; vite :$vite (marker $marker)"
cd "$here"
# The updater's dangerousInsecureTransportProtocol rides HERE, not in
# tauri.conf.json: dev-only, so BIGBRAIN_UPDATE_URL may point at a plain-http
# update feed. A release build never carries the flag.
BIGBRAIN_VAULT=$vault BIGBRAIN_ENGINE=$engine BIGBRAIN_DEV=1 BIGBRAIN_WEB_PORT=$web BIGBRAIN_API_PORT=$api \
  BIGBRAIN_WEB_URL="http://127.0.0.1:$vite/" \
  bunx tauri dev --config "{\"build\":{\"devUrl\":\"http://127.0.0.1:$vite\"},\"plugins\":{\"updater\":{\"dangerousInsecureTransportProtocol\":true}}}"
