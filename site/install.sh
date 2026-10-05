#!/bin/sh
# install.sh — BigBrain for Mac, without the Gatekeeper wall.
#
#   curl -fsSL {{SITE_URL}}/install.sh | sh
#
# curl sets no quarantine flag, so the app opens like any other. It is the
# same ad-hoc-signed build the .dmg carries — which, downloaded by a browser,
# macOS asks you to allow under Privacy & Security once per version, because
# the build is not notarized (#576). This route has no dialog.
#
# What it does: fetch BigBrain_{{APP_VERSION}}_aarch64.zip, check its sha256,
# ask a BigBrain running FROM THE SAME PLACE to quit, replace
# /Applications/BigBrain.app (~/Applications when /Applications is not yours),
# open it. No sudo, ever. Rendered by site/build.ts from site/install.sh:
# the version, the file and its hash are the build's, so this script and the
# file beside it cannot disagree.
#
#   BIGBRAIN_INSTALL_DIR   where the .app goes (default /Applications, else ~/Applications)
#   BIGBRAIN_BASE_URL      where to fetch from (default {{SITE_URL}})
#   BIGBRAIN_NO_OPEN=1     install, do not launch
set -eu

main() {
  VERSION="{{APP_VERSION}}"
  ZIP="{{ZIP}}"
  SHA256="{{ZIP_SHA256}}"
  BASE="${BIGBRAIN_BASE_URL:-{{SITE_URL}}}"

  # Linux visitors are usually setting up a shared vault: send them (and their
  # agents) to the runbook rather than a dead end.
  [ "$(uname -s)" = Darwin ] || die "this installer is for macOS — BigBrain for Mac is the only build so far.
  Setting up a shared vault on a server? Follow https://github.com/elsehow/BigBrain/blob/main/deploy/shared-vault/README.md"
  [ "$(uname -m)" = arm64 ] || die "this build is for Apple silicon (arm64); this Mac is $(uname -m)"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if ! xcode-select -p >/dev/null 2>&1; then
    say "BigBrain vaults require git. Before setup, install Xcode Command Line Tools: xcode-select --install"
    say "Full Xcode is not required. Finish the tools installer, then choose your vault folder in BigBrain."
  fi

  dest="${BIGBRAIN_INSTALL_DIR:-}"
  if [ -z "$dest" ]; then
    if [ -w /Applications ]; then dest=/Applications; else dest="$HOME/Applications"; mkdir -p "$dest"; fi
  fi
  [ -d "$dest" ] || die "$dest is not a directory"
  app="$dest/BigBrain.app"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/bigbrain-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT

  say "fetching BigBrain $VERSION from $BASE"
  curl -fL --progress-bar -o "$tmp/$ZIP" "$BASE/download/$ZIP"
  got=$(shasum -a 256 "$tmp/$ZIP" | cut -d' ' -f1)
  [ "$got" = "$SHA256" ] || die "checksum mismatch for $ZIP (got $got, expected $SHA256) — not installing"

  ditto -x -k "$tmp/$ZIP" "$tmp/unpacked"
  [ -d "$tmp/unpacked/BigBrain.app" ] || die "the archive does not contain BigBrain.app"
  # Apple's xattr by absolute path: a PyPI `xattr` on PATH (pip, brew) has no
  # -r, prints its usage to STDOUT, and the quarantine stays (seen 2026-09-01).
  /usr/bin/xattr -rd com.apple.quarantine "$tmp/unpacked/BigBrain.app" >/dev/null 2>&1 || true

  # A BigBrain running from the bundle we are about to replace: ask it to
  # quit rather than swap its files under it. One running from elsewhere
  # (a build being tried, another copy) is not ours to touch.
  for pid in $(pgrep -x bigbrain-desktop 2>/dev/null || true); do
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      "$app"/*)
        say "asking the running BigBrain to quit"
        osascript -e 'tell application "BigBrain" to quit' >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
        n=0
        while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
        kill -0 "$pid" 2>/dev/null && die "BigBrain is still running — quit it (the cube in the menu bar → Quit BigBrain) and run this again"
        ;;
    esac
  done

  if [ -e "$app" ]; then
    prev=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
    say "replacing BigBrain $prev at $app"
    rm -rf "$app"
  fi
  ditto "$tmp/unpacked/BigBrain.app" "$app"
  say "installed BigBrain $VERSION → $app"
  say "the bigbrain command appears at ~/.local/bin/bigbrain when the app first runs"
  [ -n "${BIGBRAIN_NO_OPEN:-}" ] || open "$app"
}

say() { printf 'bigbrain: %s\n' "$*"; }
die() { printf 'bigbrain: %s\n' "$*" >&2; exit 1; }

# Everything above is read before anything runs: a download that stops
# halfway executes nothing, not half of an install.
main "$@"
