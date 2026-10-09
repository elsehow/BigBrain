# Release assets

The homepage belongs exclusively to `elsehow/bigbrain.cool`. This repo builds
app downloads, the installer, update feed, browser extensions, and permanent
email images. It must never build or publish a root homepage.

## Production ownership

On `bigbrain.exe.xyz`, nginx on port 8000 serves both public hostnames:

- `/srv/website` (owner `bb-website`): homepage, website CSS/fonts and build metadata.
- `/srv/releases` (owner `bb-releases`): `/download/`, `/install.sh`, the update
  feeds (`/update.json`, and `/latest.json` frozen at the key-rotation bridge),
  `/plugins/`, and `/email/` via explicit nginx routes.
- `/srv/site` is retired and is not served. Never deploy there.

Each directory is mode 755 with a separate owner. Deployment rsync runs as that
owner, without root privileges. The administrative SSH account retains sudo for
server maintenance; these are safeguards for deployment commands, not a security
boundary against an administrator deliberately invoking root.

The split fixes the 2026-09-21 incident: an app release replaced the standalone
website with the obsolete homepage. Do not restore a shared publish root.

## App release

From the repository root, in a terminal you run yourself (signing is never an
agent's; `desktop/README.md` explains why and holds the key-rotation steps):

```sh
read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD && export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
(cd desktop && TAURI_SIGNING_PRIVATE_KEY=~/.config/bigbrain/updater-v2.key bunx tauri build --bundles app)
bun run site:build -- --app desktop/src-tauri/target/release/bundle/macos/BigBrain.app
bun run site:deploy
```

The key is `updater-v2.key`, encrypted, with its passphrase in the maintainer's
password manager. The first key, `updater.key`, is retired: every app since the
bridge release pins the v2 key and rejects an update the old key signs.

The publisher rejects legacy builds containing `index.html`, uploads only release
paths, retains old archives, and publishes the update feed (`update.json`) last. It verifies that the
website hashes stayed unchanged and that the public update feed matches the build.
Never use a root-level `rsync --delete` for releases.

For an extension-only release:

```sh
bun run site:build
bun run site:deploy extensions
```

That mode leaves the installer, app archives and update feed alone. Preview the
extension page using `python3 -m http.server 4174 --directory site/dist`, at
`http://localhost:4174/plugins/`. Homepage work happens in the website repo.

`site/nginx/bigbrain-site` is the source for
`/etc/nginx/sites-available/bigbrain-site`; validate with `sudo nginx -t` before
reloading. Preserve the routing split whenever editing it. Email PNG names and
bytes are permanent; never replace existing images with different bytes.

## Acquisition KPI

The installer has no telemetry callbacks, notice, prompt, or opt-out flag.
Nginx records installer and archive requests in
`/var/log/nginx/bigbrain-downloads.log`. The standalone website posts only
`copy_install` and `download_dmg` button clicks to `/site-events/<event>`;
these go to `/var/log/nginx/bigbrain-clicks.log`.

Click events contain the button name and a `web` or `dev` source label only.
There are no cookies, user IDs, fingerprints, or installer progress reports.
Local previews are counted separately as `dev`; checks use `test` and are
excluded by the reporter. Both dedicated log formats omit IP, referrer,
user agent, and raw query strings. Normal nginx log rotation applies.

```sh
ssh bigbrain.exe.xyz 'sudo cat /var/log/nginx/bigbrain-clicks.log /var/log/nginx/bigbrain-downloads.log' | python3 site/install-metrics.py
# Optionally append a UTC date, e.g. 2026-09-19.
```

These KPIs measure clicks and download requests, not completed installs or
unique people. Fetch counts include successful GETs (200/206), including
retries and range requests; HEAD probes are excluded. Click collection is
best effort and public, so blocking and synthetic traffic affect counts.
Old install-event logs are historical only and are ignored by the reporter.
