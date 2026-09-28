# Desktop consent and feedback integration — 2026-09-25

## Provenance

Fresh isolated worktree `.claude/worktrees/codex-desktop-consent-feedback`, branch
`codex/desktop-consent-feedback`, created from fetched origin/main `364d3e67`.
Version 0.7.28. Main advanced during testing to `55287f28` (#961, CI changes);
this candidate remains based on the recorded baseline, one commit behind it.
Installed `/Applications/BigBrain.app` still reports engine `565de2ec`, built
2026-09-25T15:48:03Z. It was neither replaced nor used as evidence for this change.

Reviewed commits applied without conflicts:

| Source | Integration copy |
| --- | --- |
| Feedback `8881db3d` | `94b8a25b` |
| Survey configuration `c507b0c0` | `0f58c1d5` |
| IP-discard disclosure `8807ea90` | `4c338760` |
| Final onboarding consent `f39ac8a5` | `e0e96623` |
| Consent button refinement `1f0c0c22` | `2c2ae083` |

Integration commit `346c76aa` adds the reviewed uncommitted feedback form copy,
angular styling, keyboard/privacy link, simulated fake API and matching tests/docs.
Those four files were copied as a checked patch, SHA-256
`6c0e71ef0fab1e0249aee723469ec35d47a524b4c1c2f73532cc5d67127e6e39`.
The overlapping SidebarWorkbench controls were combined manually in this new
worktree: onboarding restart plus the feedback success/failure selector. No
production conflict resolution was needed. The original feedback deletion notes
were not copied or changed. Original feedback/onboarding worktrees and previews
5295/5301 remain intact; the website worktree and preview 5299 were untouched.

## Combined behavior and checks

The four connection steps, disclosures and No thanks / Opt-in! order remain.
Consent is default-off, persistent, and separate from feedback. Existing choices
and completed/legacy vaults bypass the prompt. Failed consent/completion saves,
no pre-consent backfill, withdrawal and retry semantics remain covered.

- 52 focused tests, 210 assertions: telemetry, feedback, firstRun,
  desktopCommands, httpx, uiEntryPoints.
- Root typecheck and lint; Svelte check (zero warnings/errors); production build:
  passed. Existing Vite large-chunk advisory remains.
- Chrome and WebKit `telemetrySetup.browser.cjs`: built production AppShell,
  real initialization, synthetic intercepted APIs. Checks consent failures,
  restart, existing decisions, withdrawal, mobile and nine-theme contrast.
  Added combined flow: decline analytics → feedback failure → close/reopen draft
  → successful retry with identical payload/ID; analytics stays off. All external
  requests are blocked.
- Chrome and WebKit `feedback.browser.cjs` with `FEEDBACK_PRODUCTION=1`: production
  bundle and CSP, synthetic fixture; keyboard/focus, empty input, offline/server
  failure, draft retention, duplicate submit, retry identity, mobile width.
- Chrome and WebKit `firstRunFlow.browser.cjs`: four connection steps, explicit
  navigation, clients/integrations and save failures, then final consent.
- `onboardingPreview.browser.cjs`: actual interactive fixture, simulated enabling,
  restart/persistence, feedback failure/retry selector, no API network traffic.
- Native Rust `cargo test --lib --locked`: 11 passed. These test boot ownership,
  shim behavior, port conflicts, readiness and shutdown using disposable fixtures;
  they do not open a native window.

Browser commands use `VIEWER_URL=http://127.0.0.1:5303` (append `/dist/index.html`
for firstRunFlow), `BROWSER=webkit` for the WebKit variant. Feedback uses
`FEEDBACK_PREVIEW_URL=http://127.0.0.1:5303`, `FEEDBACK_PRODUCTION=1`, and
`FEEDBACK_BROWSER=webkit` for its WebKit variant.

## Local package

Built using the supported Tauri path, explicitly unsigned, no updater artifacts:

```sh
cd desktop
bunx tauri build --debug --bundles app --no-sign --ci --config '{"productName":"BigBrain Consent Review","identifier":"cool.bigbrain.consent-review","bundle":{"createUpdaterArtifacts":false}}'
```

Artifact: `desktop/src-tauri/target/debug/bundle/macos/BigBrain Consent Review.app`.
Identifier `cool.bigbrain.consent-review`; engine BUNDLE `346c76aa`, built
2026-09-25T19:09:40Z. Executable SHA-256:
`25745a095ebe92ce75e7cd2b78e8c5228cd3ce568182ed09ad216d500a6e839b`.
Fourteen packaged engine/route/schema/UI files matched the tested worktree
byte-for-byte, including every built viewer asset. Subsequent changes are test
harness, documentation and dev-only preview controls, outside the shipped viewer.

The candidate's **bundled Bun** ran `test/support/packagedConsentFeedback.ts`
against its **bundled engine**. PASS: real loopback telemetry/feedback routes,
synthetic disposable consent file, mocked ingestion, default-off, separate IDs,
feedback failure/retry/deduplication with analytics off, exact metadata allowlist,
no pre-consent backfill, withdrawal queue clearing and constructor restart.
The harness rejects non-loopback global fetches; ingestion uses explicit mocks.
It creates no connector credentials and removes its scratch profile on completion.

Safe repeat from the worktree root (this does not launch the native application):

```sh
'desktop/src-tauri/target/debug/bundle/macos/BigBrain Consent Review.app/Contents/MacOS/bun' test/support/packagedConsentFeedback.ts 'desktop/src-tauri/target/debug/bundle/macos/BigBrain Consent Review.app/Contents/Resources/resources/engine'
```

### Native-window smoke remains blocked

No native candidate was launched. Inspection of actual startup found:

- `plan_boot` in `desktop/src-tauri/src/lib.rs` normally rewrites
  `~/.local/bin/bigbrain`. Pointing `BIGBRAIN_ENGINE` at the bundled tree can skip
  that write, but does not isolate the following engine state.
- `lib/engine.ts::configDir()` unconditionally uses `homedir()/.config/bigbrain`;
  the production telemetry singleton reads/writes consent there. Provider and
  integration discovery also uses home-based state.
- `bin/desktop.ts` refreshes installed plugins outside dev mode and explicitly
  supplies `HOME: homedir()` to children. A scratch vault alone is insufficient.
- Changing app identifier separates native app identity, but does not redirect
  these engine paths. No supported complete profile override was found. No
  production isolation feature was silently added.

The earlier packaged-verification runbook backed up/restored real installation
consent and sent live events; those actions are outside this task. This is an
isolation/authorization boundary, not a failed browser test or an approval-system
rejection. Native WKWebView/Tauri interaction, bundled supervisor initialization,
real first-run door handover and a native restart remain untested together.
The package is available for artifact review; do not double-click it expecting an
isolated test profile. A supported isolated profile/VM is needed for native smoke.

## Review preview and release gates

Combined simulated production AppShell:
`http://127.0.0.1:5303/sidebar-workbench.html?onboarding=analytics&feedback=success`.
Use Restart preview to reset saved browser state. Choose No thanks, then move the
pointer near the bottom-right Feedback button. Send is simulated; the selector
switches success/failure so drafts/retry can be reviewed. Use `onboarding=start`
to traverse all four connection steps. Connections, vault creation and consent
are browser-local fixtures; no engine collector runs. No real vault is written.

Remaining gates: isolated packaged native-window smoke; website owner's factual
review/publication of the final privacy notice (owned separately); explicit
release/activation approval when the user resumes it. Feedback activation and
all deletion tests remain paused pending the user's support discussion. No live
analytics/feedback submission, settings change, vendor contact, deletion, signing,
installation, push, PR, merge, publication, deployment or issue closure occurred.
