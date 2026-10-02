#!/bin/sh
# build-llama-server.sh — the intake firewall's model server, a second
# sidecar beside bun (lib/firewallModel.ts, bin/firewall-server.ts):
#
#   src-tauri/binaries/llama-server-<target-triple>
#
# llama.cpp, pinned to one commit, built static with Metal embedded and no
# OpenSSL (it only ever listens on 127.0.0.1), so the binary needs nothing
# but macOS itself — the app stays the whole install. GGML_NATIVE=OFF: the
# build machine's CPU must not decide what an M1 can run.
#
# The pin is ggml-org/llama.cpp#29831 (Clef support) until it merges; move
# it to a release tag then, and rerun deploy/firewall/eval against the new
# build before shipping it.
#
# Cached by commit under desktop/.cache/, so a rebuild is a copy (~0.1 s);
# the first build takes a few minutes.
set -eu
LLAMA_REPO=https://github.com/ggml-org/llama.cpp.git
LLAMA_COMMIT=1e265f2111a894c85560d667216d4dd7930474dc

here=$(cd "$(dirname "$0")" && pwd)
triple=${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}
cache="$here/.cache/llama.cpp-$LLAMA_COMMIT"
out="$cache/build/bin/llama-server"

if [ ! -x "$out" ]; then
  echo "llama-server: building llama.cpp $LLAMA_COMMIT (first time only)"
  command -v cmake >/dev/null || { echo "llama-server: cmake is required to build the firewall's model server" >&2; exit 1; }
  rm -rf "$cache"
  mkdir -p "$cache"
  git -C "$cache" init -q
  git -C "$cache" fetch -q --depth 1 "$LLAMA_REPO" "$LLAMA_COMMIT"
  git -C "$cache" checkout -q FETCH_HEAD
  cmake -S "$cache" -B "$cache/build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
    -DLLAMA_OPENSSL=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 >/dev/null
  cmake --build "$cache/build" --target llama-server -j "$(sysctl -n hw.ncpu)" >/dev/null
fi

# Nothing outside the OS: a Homebrew dylib here would work on this machine
# and nowhere else.
foreign=$(otool -L "$out" | tail -n +2 | awk '{print $1}' | grep -v -e '^/System/' -e '^/usr/lib/' || true)
[ -z "$foreign" ] || { echo "llama-server: links outside macOS — $foreign" >&2; exit 1; }

mkdir -p "$here/src-tauri/binaries"
rm -f "$here/src-tauri/binaries/llama-server-$triple"
cp "$out" "$here/src-tauri/binaries/llama-server-$triple"
chmod 755 "$here/src-tauri/binaries/llama-server-$triple"
mkdir -p "$here/src-tauri/resources/licenses"
cp "$cache/LICENSE" "$here/src-tauri/resources/licenses/llama.cpp.txt"
du -sh "$here/src-tauri/binaries/llama-server-$triple" | sed 's/^/llama-server: /'
