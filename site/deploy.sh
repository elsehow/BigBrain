#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mode=${1:-app}
case "$mode" in app|extensions) ;; *) echo 'Usage: bun run site:deploy [app|extensions]' >&2; exit 1;; esac
for path in site/dist/plugins/index.html site/dist/email; do test -e "$path"; done
if test -e site/dist/index.html; then
  echo 'Refusing legacy build containing a homepage; rebuild with bun run site:build.' >&2
  exit 1
fi
if test "$mode" = app; then
  test -s site/dist/install.sh
  # The one update feed the build wrote: the app's own, or the previous one
  # for the bridge release of a key rotation (site/build.ts feedName, --feed).
  set -- site/dist/*.json
  test "$#" -eq 1 && test -s "$1" || { echo 'Expected exactly one update feed in site/dist' >&2; exit 1; }
  feed=$(basename "$1")
  bun -e 'const fs=require("fs"); const f=JSON.parse(fs.readFileSync(process.argv[1])); for(const p of Object.values(f.platforms)) {const name=new URL(p.url).pathname; if(!name.startsWith("/download/BigBrain_") || !fs.existsSync("site/dist"+name)) throw Error("Missing update archive");}' "site/dist/$feed"
fi
host=bigbrain.exe.xyz
before=$(ssh "$host" 'sha256sum /srv/website/index.html /srv/website/website-build.json')
# No --delete: old published archives and permanent email URLs must survive.
rsync -rltz --rsync-path='sudo -u bb-releases rsync' site/dist/plugins site/dist/email "$host:/srv/releases/"
if test "$mode" = app; then
  rsync -rltz --rsync-path='sudo -u bb-releases rsync' site/dist/download "$host:/srv/releases/"
  rsync -rltz --rsync-path='sudo -u bb-releases rsync' site/dist/install.sh "$host:/srv/releases/"
  # Publish the update feed only after all referenced artifacts are present.
  rsync -rltz --rsync-path='sudo -u bb-releases rsync' "site/dist/$feed" "$host:/srv/releases/"
fi
after=$(ssh "$host" 'sha256sum /srv/website/index.html /srv/website/website-build.json')
test "$before" = "$after" || { echo 'ERROR: website changed during release' >&2; exit 1; }
if test "$mode" = app; then
  remote=$(curl -fsSL "https://bigbrain.exe.xyz/$feed" | shasum -a 256 | cut -d ' ' -f 1)
  local_hash=$(shasum -a 256 "site/dist/$feed" | cut -d ' ' -f 1)
  test "$remote" = "$local_hash"
fi
echo 'Published release assets; website hashes unchanged.'
