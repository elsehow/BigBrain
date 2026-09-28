#!/bin/sh
# Copies guest evidence to the per-run output disk. Run after quitting BigBrain.
# Consent/telemetry state and logs are synthetic: this guest never held real data.
set -u
out=/Volumes/BB_SMOKE_OUT/evidence
mkdir -p "$out"
cp -R "$HOME/Desktop/BigBrain-Smoke-Evidence" "$out/" 2>&1
mkdir -p "$out/config"; cp -R "$HOME/.config/bigbrain/." "$out/config/" 2>&1
# Token stores are guest-local secrets for a throwaway vault; record names only.
rm -rf "$out/config/tokens"; ls -la "$HOME/.config/bigbrain/tokens" > "$out/config/tokens-listing.txt" 2>&1
mkdir -p "$out/logs"; cp -R "$HOME/Library/Logs/." "$out/logs/" 2>&1
ls -la "$HOME/.local/bin" > "$out/local-bin.txt" 2>&1
/bin/ps -axww -o pid,ppid,pgid,command > "$out/processes-after-quit.txt"
/bin/date -u > "$out/collected-at.txt"
sync
echo "collected to $out"
