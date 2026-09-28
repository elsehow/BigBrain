# Optional onboarding analytics: local verification

Baseline: origin/main `364d3e67`, fetched 2026-09-25; branch
`codex/onboarding-analytics`, app version 0.7.28. Installed desktop BUNDLE
reports engine `565de2ec`; the browser checks below do not test that binary.

The four connection steps remain Vault, Providers, Clients and Integrations.
New vaults with reporting configured and no installation decision continue to
“Help improve BigBrain.” Both choices persist consent then complete onboarding.
The separate first-run analytics prompt is removed. Completed/legacy vaults and
existing choices bypass the new prompt. A failed completion write after a saved
choice offers Finish on reload without asking again or changing that choice.

Inspection covered AppShell → App setup/telemetry initialization, the pre-vault
desktop door (telemetry unavailable), engine route initialization, progress
validation/persistence, and the installation-owned collector. Existing withdrawal
clears pending batches and aggregates, aborts delivery and removes the installation
ID. This change also resets the CPU baseline and excludes operations that cross
a consent change. Local diagnostics still work with sharing off. Withdrawal does
not delete delivered reports.

## Preview

Run Vite on port 5301 from `web/ui`. Production AppShell, actual App initialization,
synthetic API responses and browser-local persistence:

- `http://127.0.0.1:5301/sidebar-workbench.html?onboarding=start`
- `http://127.0.0.1:5301/sidebar-workbench.html?onboarding=analytics`

Use Restart preview to clear its saved state. From start: Create → Go, enter a
sample name, Next, Connect Claude, Next, Skip clients, Skip integrations. Both
analytics choices are simulated. Connections and vault creation are simulated;
client/integration catalogues are empty. No engine collector runs in this preview.
The fixture intercepts API requests and blocks external JavaScript fetches before
mounting AppShell. It does not change installation consent or write vault data.
The actual external privacy link opens the public website; its draft is unpublished.

## Checks

- `bun test test/telemetry.test.ts test/firstRun.test.ts test/desktopCommands.test.ts test/httpx.test.ts`: 44 passed, 175 assertions.
- `bun run typecheck`, `bun run lint`; in `web/ui`, `bun run check` and `bun run build`: passed. Existing Vite large-chunk advisory remains.
- `node test/support/telemetrySetup.browser.cjs` and `BROWSER=webkit node test/support/telemetrySetup.browser.cjs`: passed against built production AppShell, with CSP and all APIs/external traffic intercepted. Checks ordering, choice ordering and themed contrast, keyboard details, mobile layout, consent/completion failures, reloads, existing choices, legacy bypass, Settings withdrawal and pagehide/pageshow presence lifecycle.
- `VIEWER_URL=http://127.0.0.1:5301/dist/index.html node test/support/firstRunFlow.browser.cjs`, also with `BROWSER=webkit`: passed four-step provider/client/integration interactions followed by analytics. Synthetic APIs only.
- `node test/support/onboardingPreview.browser.cjs`: verifies the interactive fixture's full initialization/flow, simulated enabling, reload, restart, and no API requests reaching the network.
- Separate mock-transport compatibility check against the committed #952 feedback sender at `8807ea90`: feedback succeeds with analytics disabled, no telemetry send, person processing disabled and GeoIP suppression preserved. No external submissions.

## Release gates

Button refinement after `f39ac8a5`: No thanks comes first; Opt-in! follows with
inverted theme colors, offset hover shadow and inset pressed state. Chrome and
WebKit check all nine themes for at least 4.5:1 button text contrast (including
opt-in hover/pressed), fixed button geometry, keyboard focus, no automatic consent
and reduced-motion transitions. Both consent browser regressions and the interactive
preview check pass. Focused telemetry/setup tests: 27 passed, 115 assertions;
typecheck, lint, Svelte check and production build pass.

The public privacy notice remains an unpublished draft and needs owner review and
publication before release. Feedback #952 is on a separate worktree, absent from
this main baseline: its work and preview were preserved. Combined production UI
integration needs checking when those branches meet. A packaged native-app smoke
test remains separate from these Chrome/WebKit production-shell checks. No push,
PR, deployment, external settings changes or live analytics/feedback submissions
were performed.
