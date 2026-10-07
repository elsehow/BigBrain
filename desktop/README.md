# desktop/ — the BigBrain app (Tauri)

The desktop app is a shell, not a second engine: **bun as a sidecar, the
engine tree as bundled resources, one supervisor process.** Nothing here
calls a model directly — the bundled engine runs app-owned model work through
embedded Pi. Model subscriptions connect in the app; external MCP clients have
separate credentials and permissions. A vault moves between the app and a bare
`bun bin/desktop.ts` from a checkout without noticing: same scripts, same
env, same `.state/logs/<job>.log`, same schedule (`CADENCE` in
`lib/desktopSchedule.ts`).

```
BigBrain.app/Contents/
  MacOS/bigbrain-desktop        the Tauri shell (src-tauri/src/lib.rs)
  MacOS/bun                     the sidecar — bun itself
  Resources/resources/engine/   bin/ lib/ integrations/ prompts/ deploy/
                                clients/ web/ + production node_modules
```

`lib.rs` resolves the vault (`BIGBRAIN_VAULT` → `~/.config/bigbrain/vault` →
`~/vault`) and the engine (below), spawns `bun engine/bin/desktop.ts` with a
stdin pipe, waits for the viewer to answer with this launch's session
(`~/.config/bigbrain/viewer-session-4747`, written by the supervisor before
it binds), opens a webview on `http://127.0.0.1:4747/` through the session
bootstrap, puts the cube in the menu bar, and kills the child on exit. If something already answers
on the engine's ports (a second copy of the app, an engine started from a
checkout) it attaches instead of starting another engine.

`bin/desktop.ts` runs the api and the viewer as long-lived children
(restart with backoff) and fires tend / publish / each enabled integration
from one heartbeat against per-job "next fire" stamps
(`lib/desktopSchedule.ts`), skipping a fire whose previous run is still
going. It shuts everything down on SIGTERM, SIGINT, SIGHUP, or EOF on
stdin — which is how it notices the shell died without telling it.

## Which engine runs — and the `bigbrain` command

The app runs **the engine inside the bundle.** What shipped is what runs,
the app's version is the engine's version, and an update is installing the
new app — nothing on the machine changes which code the app runs:

| you have | the app runs | `bigbrain` is |
|---|---|---|
| the app | the bundled engine | a shim the app writes, running the bundled engine with the bundled bun — rewritten each launch (in case the app moved) |
| the app and a CLI install (`bigbrain install` made `~/.local/bin/bigbrain` → `<checkout>/bin/cli.ts`) | the bundled engine | **taken over**: the app replaces the symlink with its shim — on a machine running the app, the app owns the command |
| `BIGBRAIN_ENGINE=<tree>` in the environment | that tree | untouched (the dev loop) |

One pointer: the command the viewer tells people to run and the engine the
app is gardening with are the same code. A script of your own at
`~/.local/bin/bigbrain` (no marker, not an install's symlink) is left alone.
The engine's side reads the shim through `lib/bigbrainCommand.ts` (its
`# engine:` line), so `bigbrain install`'s preflight is satisfied by it and
`install` never overwrites it.

Until 2026-08-27 the precedence was the other way round — the app deferred
to the checkout behind the command — and a checkout whose `web/ui/dist`
had not been rebuilt shadowed a freshly built app with an old viewer. The
dev loop is `BIGBRAIN_ENGINE`, explicitly, and nothing else is.

**Already running.** If something answers on either engine port when the
app starts, it asks `GET /api/engine` which engine that is. This engine (a
second copy of the app, a supervisor still winding down): attach, don't
fight. Any other — an older app still in the menu bar, the orphaned
children of a supervisor that died hard, an engine too old to answer —
gets a dialog that names the processes holding the ports (`lsof`) and
offers **Stop it and open BigBrain**: SIGTERM (then SIGKILL), wait for the
ports, relaunch. If they come back, a second dialog says so. Never a
window showing a stranger's viewer as this version. A lone occupied port
also triggers the check. After starting its own supervisor, the app waits
for a viewer identifying that engine and supervisor before opening the
window; a different server winning the port race cannot count as ready.

## The menu bar (#574)

The cube in the menu bar is presence, not a control panel: it says the
engine is running, a left click opens the window, a right click is the
menu — **Quit BigBrain**. Closing the window hides it; the engine keeps
gardening. The Dock icon and Cmd-Tab bring the window back too. Everything
about the vault lives in the viewer; nothing about the schedule is a button
("garden now" would be a lie — the tick's `tendDue` is the only thing that
knows whether there is work, and the gardener is whoever picks the queue
up).

**Sleep / wake.** The supervisor's heartbeat notices when it has been away
(a gap of more than three beats) and fires every overdue job once — the way
launchd treated a missed `StartInterval` — never once per missed interval.

## Icons

`desktop/icon/app-icon.svg` (the brand cube on Apple's 1024/824 rounded
plate) and `desktop/icon/tray-template.svg` (the cube as a macOS template
image — alpha only, in the brand's own monochrome)
are the sources; `sh icons.sh` (`bun run icons`) renders both into
`src-tauri/icons/` with `tauri icon`. The mark itself is
`web/ui/src/assets/logo.svg`, geometry untouched — the same geometry
`web/ui/src/lib/logomark.ts` now derives it from, which is also where
the mark's motion lives (`bun run logomark:render` cuts it as video;
`brand/README.md`, "The mark, moving").

## The dev loop

```sh
BIGBRAIN_VAULT=~/some-scratch-vault bun run desktop:dev      # from the engine root
```

Nothing installed, nothing bundled: the engine is **this checkout**
(`BIGBRAIN_ENGINE`), api and web run under `bun --watch` and restart themselves
on an edit (`BIGBRAIN_DEV`), the viewer comes from vite with HMR (`/api` proxied
to the engine's web port), and the shell runs under `tauri dev`, which
recompiles and relaunches on a Rust edit. Ports default to :4757/:4758
(engine) and :5173 (vite) so it sits beside a live install. A scratch vault
is required, never a real one — the /verify rule; tend on it still runs
`claude -p` on your subscription when work is due.

## Build

```sh
bun install && (cd web/ui && bun install) # engine root + viewer deps
cd desktop && bun install                 # @tauri-apps/cli (Rust + Xcode CLT required)
bunx tauri build --debug                  # → src-tauri/target/debug/bundle/macos/BigBrain.app (+ .dmg)
```

`build-resources.sh` (the `beforeBuildCommand`) builds the viewer bundle
itself — a stale `web/ui/dist` on the build machine cannot ship (it did
once: 0.1.8 went out with a months-old UI inside a current shell).

A **release** build must also sign the update it becomes food for. The
signing key lives at `~/.config/bigbrain/updater-v2.key` (mode 0600) and is
encrypted: its passphrase lives in the maintainer's password manager, never
in a file, a shell profile or an agent's environment.

```sh
read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD && export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
TAURI_SIGNING_PRIVATE_KEY=~/.config/bigbrain/updater-v2.key bunx tauri build --bundles app
bun run site:build -- --app src-tauri/target/release/bundle/macos/BigBrain.app
# From the repo root: bun run site:deploy (site/README.md). Never upload to /srv/site.
```

Build releases from a terminal you run yourself, not from an agent: anything
that can read the key file and the passphrase can sign an update every
install accepts. Without the passphrase in the environment the build stops
after bundling to ask at a terminal, and with no terminal it fails with
"Device not configured" — leaving a NEW `.app.tar.gz` beside the OLD `.sig`
from the last release, which the site build would ship as a pair
(2026-09-06). If that has already happened, delete the stale `.sig` and sign
the tarball alone: `bunx tauri signer sign -f ~/.config/bigbrain/updater-v2.key
src-tauri/target/release/bundle/macos/BigBrain.app.tar.gz`.

**Key rotation.** An installed app accepts only updates signed by the key
pinned in its `tauri.conf.json` (`plugins.updater.pubkey`), and polls only
the feed its endpoint names (`site/build.ts` `feedName`). So a key rotates by
moving the feed:

1. Generate the new key with a passphrase:
   `bunx tauri signer generate -w ~/.config/bigbrain/updater-v<n>.key`.
2. Put its public key in `tauri.conf.json` and point the endpoint at a new
   feed (e.g. `update-v<n>.json`; add it to `site/nginx/bigbrain-site`).
3. Cut the **bridge** release: build it signed with the OLD key and publish
   it on the old feed — `bun run site:build -- --app … --feed <old feed>`
   writes that feed instead of the new one. Installed apps update to the bridge,
   which pins the new key and polls the new feed.
4. Every later release is signed with the new key and lands only on the new
   feed. The old feed is frozen at the bridge, so an app that was offline
   for months still crosses over. Then delete the old key.

The first key (`updater.key`, unencrypted) is retired this way: 0.8.x apps
poll `latest.json`, so the bridge is built with `--feed latest.json`; later
apps poll `update.json`.

**Signing (#576).** The bundle is **ad-hoc signed** (`signingIdentity: "-"`
in `tauri.conf.json`): a real seal over every file, no Apple identity. On a
downloaded copy Gatekeeper then says "Apple could not verify BigBrain is
free of malware" and the person opens it once via **System Settings →
Privacy & Security → Open Anyway** (Sequoia dropped right-click → Open for
this). Without that seal — what shipped up to 0.1.3 — the linker's stub
signature claims resources the bundle never sealed, `codesign --verify`
fails, and a quarantined copy is reported as *"damaged and can't be
opened"* with Trash as the only way out. Developer ID + notarization is the
step that removes the dialog altogether; until then, after a build:
`codesign --verify --deep --strict BigBrain.app && spctl --assess --type
execute BigBrain.app` — the first must pass, the second says "rejected"
(unnotarized) and that is expected. The sidecar is copied `755`, not bun's
own read-only mode, because the bundler's `xattr -cr` before signing has to
write it.

**The microphone (#770).** The pilot opens the mic from the webview while
SPACE is held. Two files make that legal: `Info.plist` beside
`tauri.conf.json` (merged into the bundle's; it carries the
`NSMicrophoneUsageDescription` macOS shows once — without it the process is
killed on the first `getUserMedia` rather than asked) and the
`com.apple.security.device.audio-input` entitlement in `entitlements.plist`
(the hardened runtime's gate). The page's own permission request is
answered by the webview: wry's `WKUIDelegate` grants
`requestMediaCapturePermission` outright, so there is no second dialog.

The DMG step (Tauri's `bundle_dmg.sh`) needs a GUI session — from an agent
or ssh, build with `--bundles app` and let the site build cut the downloads
from the `.app`: `bun run site:build -- --app <BigBrain.app>` makes the zip
that `install.sh` fetches and the `.dmg` (site/README.md).

## Updates ("BigBrain 0.2.0 is ready")

Installed apps update themselves — with a click, never behind anyone's
back. The viewer asks the shell on launch and every six hours
(`web/ui/src/lib/update.svelte.ts` → `update_check` in lib.rs), the shell
fetches `https://bigbrain.exe.xyz/latest.json` (tauri-plugin-updater) and
compares versions; a newer one puts a one-line banner above the top bar
(`UpdateNudge.svelte` — the workbench has its three states). The button
downloads the `.app.tar.gz` named in latest.json, verifies its minisign
signature against the pubkey baked into `tauri.conf.json`, swaps
`/Applications/BigBrain.app` in place, stops the engine exactly as quit
does, and relaunches. × keeps that version quiet for good (`bb-update-skip`
in the viewer's localStorage); the next version speaks again.

Two keys, two jobs: the **updater key** (`~/.config/bigbrain/updater.key`,
minisign — `TAURI_SIGNING_PRIVATE_KEY` at build time) is what makes an
update installable; losing it means shipped apps refuse every future
update, so back it up. macOS **code signing** stays ad-hoc (#576) and is a
separate concern. The site build refuses to cut a release without the
signed tarball beside the `.app` (site/build.ts), so a build that forgot
the key cannot ship quietly.

`BIGBRAIN_UPDATE_URL` overrides the endpoint at runtime — how a dev copy is
pointed at a locally served latest.json without touching the shipped
config. `dangerousInsecureTransportProtocol` rides dev.sh's `--config`
override ONLY, so that override may be plain http in the dev loop; the
shipped config never carries the flag, so a release build refuses http;
the shipped endpoint is https, and either way nothing installs without the
minisign signature checking out, so an insecure feed cannot serve a fake.

`beforeBuildCommand` runs `build-resources.sh`, which copies bun to
`src-tauri/binaries/bun-<triple>` and assembles `src-tauri/resources/engine`
(`bun install --production` inside it). Both are gitignored; `BUNDLE` in the
engine copy records the commit it came from.

## Try it beside a running engine

Two engines fight over `:4747`/`:4748`, and the app refuses to attach to
one that is not its own build (see "Already running" above). To try a
build without stopping the engine you are using, point it at a copy of the
vault on other ports:

```sh
BIGBRAIN_VAULT=~/some-vault-copy BIGBRAIN_WEB_PORT=4757 BIGBRAIN_API_PORT=4758 \
  ./src-tauri/target/debug/bundle/macos/BigBrain.app/Contents/MacOS/bigbrain-desktop
```

To run it on the real vault, quit whatever engine is already on those
ports first — the app is the only supervisor there is (#645).

## First run

With no vault — nothing at `BIGBRAIN_VAULT`, no `~/.config/bigbrain/vault`
pointer, nothing at `~/vault` — the supervisor opens the **setup door**
instead of dying at import: a small server on the web port that serves the
viewer and `/api/setup`. The production shell shows the four-step wizard
(`web/ui/src/components/FirstRun.svelte`): Vault → Providers → Clients →
Integrations. Vault selection and owner identity come first; Claude and ChatGPT
providers can both connect. Installed Claude Code and Codex clients can then be
granted MCP access, and the integration library offers Browser extension and
Granola. All advances require Next/Skip/Finish, never an automatic transition.
After a folder is chosen the door closes and the engine comes up on the same port.
These controls also live in Settings. Switching from the vault card moves the
pointer and sends the supervisor `SIGUSR2`, restarting on the new vault. A bare
viewer has no setup door — there `/api/setup` is 404 and the cards name the CLI.
`lib/firstRun.ts` is the logic; `bin/desktop.ts` the door.

Existing configured vaults open directly, without forced onboarding or a content
migration. Incomplete setup resumes from `.spool/setup-progress.json`. Existing
access choices and model settings are preserved; remembering and live access default
on only when adding a new integration. Old Granola API-key accounts need MCP sign-in,
but their imported transcripts remain. The optional privacy choice stays separate.

**The plugin travels with the app.** After the engine is up, the supervisor
compares the `bigbrain` plugin Claude Code has installed with the one this
engine ships (`lib/pluginState.ts`: the version, and which directory the
marketplace points at) and, when they differ, re-points the marketplace at
the bundle and runs `claude plugin update` — so an app update updates the
plugin, and the agents card shows both versions in the meantime. Not in
the dev loop (a worktree must not hijack your real plugin), and never when
nothing is installed — that is CONNECT's job, which also refreshes.

## Not yet (tracked)

- #575 first run: the folder dialog IS wired (`VaultPicker.svelte` →
  `chooseFolder`, with a typed path where there is no shell). What is still
  missing is the interview — the charter questions `/setup` asked are not
  asked, and the vault gets `vault.example.yaml` as-is.
- #576 Developer ID + notarization (the build is ad-hoc signed — see Signing above; Gatekeeper asks once), Linux.
- Launch at login (the app has to be running for the schedule to run).
- The tray is untested on Linux (`xdg-open` for the logs folder; no activation-policy dance).
