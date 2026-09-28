#!/bin/sh
# icons.sh — render the app icon and the menu-bar icon from their SVG
# sources (desktop/icon/) into src-tauri/icons/, which the bundle and
# `include_image!` read. Run after touching either SVG; commit the output.
#
#   app-icon.svg      → 32x32 / 128x128 / 128x128@2x / icon.png / icon.icns /
#                       icon.ico / the Windows Square*Logo set  (`tauri icon`)
#   tray-template.svg → tray-template.png (128px RGBA; macOS scales it to
#                       18pt and, as a template image, keeps only its alpha)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/src-tauri/icons"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "icons: app icon → $out"
(cd "$here" && bunx tauri icon "$here/icon/app-icon.svg" -o "$out" >/dev/null)
echo "icons: tray template → $out/tray-template.png"
(cd "$here" && bunx tauri icon "$here/icon/tray-template.svg" -o "$tmp" >/dev/null)
cp "$tmp/128x128.png" "$out/tray-template.png"
rm -rf "$out/android" "$out/ios" # no mobile targets
ls -1 "$out" | sed 's/^/icons:   /'
