# Local desktop refresh — 2026-09-25

Release remains paused. This is local evidence, not release approval.

## Provenance and scope

Worktree: `.claude/worktrees/codex-feedback-consent-refresh`; branch
`codex/feedback-consent-refresh`. Fetched origin/main baseline:
`3881557b93e4173dfa2ed981d23a6854d5d98edf`; app version 0.7.28.
Implementation and CI commit: `db5dc5a6`. The installed app remains engine
`565de2ec` (built 2026-09-25T15:48:03Z); it was not launched or replaced.

Reviewed integration `ad9fb05e` was brought forward with these local copies:

| Prior integration | Refreshed copy | Change |
| --- | --- | --- |
| 94b8a25b | 5eb27c0b | Feedback (original 8881db3d) |
| 0f58c1d5 | 047fd96f | Survey configuration (original c507b0c0) |
| 4c338760 | 16520595 | IP disclosure (original 8807ea90) |
| e0e96623 | ec78c082 | Final consent step (original f39ac8a5) |
| 2c2ae083 | 41f75792 | Consent buttons (original 1f0c0c22) |
| 346c76aa | f1cb722e | Combined angular feedback UI and preview |
| ad9fb05e | 05267d22 | Prior evidence and bundled-runtime harness |

Two conflicts were mechanical: retain main's browser harness import together
with WebKit, and retain its Gmail preview initialization together with the
onboarding fixture. No product decision was changed. Main's newer integrations
UI and CI remain intact. The principal feedback, telemetry, setup, FirstRun,
AppShell and App production files match the reviewed candidate exactly.

`db5dc5a6` registers telemetrySetup, feedback and onboardingPreview in the new
22-script CI suite. Tests use its assigned preview URL and Chromium channel,
capture failure artifacts through its harness, use the built production shell,
and block external requests before initialization. Original feedback/onboarding/
integration worktrees and previews 5295/5301/5303 remain separate. Website work
and preview 5299 were not changed.

## Verification

- `bun run ci:checks`: plugin check, lint, TypeScript, production build,
  2,068 tests / 43,660 assertions, Svelte check (zero errors/warnings), passed.
  Existing Vite large-chunk advisory remains.
- Focused telemetry, feedback, firstRun, desktopCommands, httpx and uiEntryPoints:
  52 tests / 210 assertions passed.
- `bun run ci:stress`: 100 watcher iterations / 500 assertions passed.
- `PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_CHANNEL=chromium bun run ci:browser`:
  build/site checks and all 22 registered browser scripts passed, without retries
  or timeouts. Results are in ignored `artifacts/browser/results.json`.
- `cargo test --lib --locked`: 11 passed after assembling the required Bun resource.
- WebKit: telemetrySetup, feedback and firstRunFlow passed against the built
  production AppShell with intercepted synthetic APIs and external blocking.
  Covers four connection steps, default off, explicit choice, saved decisions,
  failed saves, no repeated prompt, Settings withdrawal, nine-theme contrast,
  keyboard/mobile, and independent feedback draft/failure/retry identity.

The first full test launch inherited this app session's desktop mode and server
ports: two headless route assertions failed and a subprocess could not start.
The test preload had already replaced the vault with a synthetic fixture.
Rerunning with BIGBRAIN_DESKTOP, BIGBRAIN_VAULT, BIGBRAIN_WEB_PORT,
BIGBRAIN_API_PORT and BIGBRAIN_SUPERVISOR_PID removed from the test environment
passed. No product change was made to accommodate the inherited environment.
The initial Rust attempt lacked the bundled Bun resource; the supported
`sh build-resources.sh --bun-only` preparation resolved it.

## Unsigned package and runtime

Built with `bunx tauri build --debug --bundles app --no-sign --ci` and config
`{"productName":"BigBrain Consent Review","identifier":"cool.bigbrain.consent-review","bundle":{"createUpdaterArtifacts":false}}`.
Artifact: `desktop/src-tauri/target/debug/bundle/macos/BigBrain Consent Review.app`.
BUNDLE: `db5dc5a6`, built 2026-09-25T21:40:57Z.
Executable SHA-256: `2e5bea9576845d396c494fcb871186e4357b1384fae92d9a3b8edb98c7f68c00`.
Fifteen engine/viewer files (including every built viewer asset) matched the
worktree byte-for-byte.

The packaged Bun ran `test/support/packagedConsentFeedback.ts` against the
packaged engine: PASS. Real loopback routes, disposable consent state and mocked
ingestion verify default off, separate feedback identity, metadata allowlist,
failure/retry/deduplication, no pre-consent backfill, withdrawal queue clearing
and restart persistence. Global fetch permits loopback only. No native window
was launched. Subsequent evidence-only commits do not change packaged code.

Complete native isolation is still unavailable: configDir uses homedir,
bin/desktop refreshes home-based plugins and supplies HOME to children, and
native startup can write the CLI shim. A changed app identifier or scratch vault
does not isolate these paths. Native WKWebView/Tauri interaction, supervisor
startup, first-run handover and restart remain untested together. Do not open
the package expecting an isolated profile. See the earlier integration evidence
for the exact startup analysis; those paths remain unchanged on this baseline.

## Review preview and remaining release gates

`http://127.0.0.1:5305/sidebar-workbench.html?onboarding=analytics&feedback=success`
is the running production AppShell with synthetic browser-local fixtures.
Browser opening returned success. Restart preview resets its saved state;
`onboarding=start` traverses the four connection steps. No thanks is left;
Opt-in! is right with inverted angular styling. Send is simulated. The preview
selector switches feedback success/failure. This differs from the installed
desktop and does not exercise native initialization.

Required before release: safe isolated native-window smoke; resolution of the
owner's pending PostHog support/deletion question; owner review of the essential
in-app disclosure; and explicit desktop release authorization. No new support
reply was supplied. Activation and deletion testing remain paused. A draft
survey is not a delivery lock: this candidate sends only through explicit
feedback, and every test/preview uses mocks. Shipping it would expose that path.

Private proposed addition for the separately owned notice (not published here):
“In-app feedback sends PostHog your message, app version, platform, panel type
and layout, with a separate submission identifier. It works with analytics off.”
The website owner's current release/review must establish the final wording.

No live submission, deletion, PostHog setting change, vendor message, website
edit, push, PR, merge, signing, installation, deployment or issue closure.
