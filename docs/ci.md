# CI contract

CI answers whether a change is safe to merge. Shipping 1.0.0 has separate product,
privacy and release gates. A green check does not claim those gates are complete.

## Merge checks

Every PR and main push runs one job:

- `checks` on Linux: generated plugins, lint, TypeScript, production viewer build,
  the full unit suite, and Svelte checks. The ordinary filesystem watcher regression
  remains part of the full suite.

Aim for ordinary PR feedback within five minutes, excluding runner queue time.
The ten-minute timeout is a safety bound, not the performance target. Superseded
PR runs cancel; main runs are not actively cancelled. No path filters can leave
this check pending. Keep its stable name in any repository merge rules.

The browser suite is not a merge gate: at ~11 minutes on macOS it slowed every PR
for the work we use ourselves. It runs nightly and by hand (Compatibility and
stress, below), and **an official desktop release must pass it first**: run
`gh workflow run compatibility.yml --ref <release branch>` and wait for green.
Run `bun run ci:browser` locally when a change touches what a browser test covers.

## One local command per suite

Use Bun 1.3.9 and install root dependencies with `bun install --frozen-lockfile`.
Nested UI installation is frozen too. Then:

```sh
bun run ci:checks
bun run browser:install
PLAYWRIGHT_BROWSERS_PATH=0 PLAYWRIGHT_CHANNEL=chromium bun run ci:browser
bun run ci:stress
```

`ci:browser` builds the viewer, runs packaging tests (platform-specific cases skip
outside macOS), starts its own loopback Vite server on a free port, and runs the
manifest in order. It uses disposable/synthetic data and the production AppShell.
No real vault or installed app is needed. To investigate just one script after
building, use `node bin/ci-browser.cjs sidebarWorkbench`; `--list` lists the suite.
The default browser channel outside CI is local Chrome.

## Coverage map

`test/browser-suite.json` is the ordered source of truth for both macOS merge
coverage and Linux compatibility coverage. Add a regression there once, not to
multiple workflow files. Use `test/support/browserHarness.cjs` for diagnostics.

| Scripts | Contract |
| --- | --- |
| desktopFirstRun | Built production shell, real supervisor identity, setup door |
| markdownSecurity | Hostile Markdown remains inert |
| agentOrchestration, agentRunnerSettings | Connected agents and runner controls |
| providerConnections, providerMonitoring | Provider connection and monitoring UI |
| integrationAccess, connectedClients | Grants and connected-client controls |
| firstRunFlow | Setup navigation, persistence, errors and existing-vault bypass |
| telemetrySetup, feedback | Built production shell: consent lifecycle, independent feedback, allowlist, failure/retry, keyboard, mobile and themed contrast; ingestion mocked before initialization |
| onboardingPreview | Combined interactive synthetic preview, browser-local decisions and simulated feedback outcomes; API network blocked |
| pilotCategories | Category selection, movement and return navigation |
| settingsLayout | Settings geometry and navigation |
| sidebarWorkbench | GPU picking, hover, camera, search, recents and chat lifecycle |
| documentTab, notePreviewPath | Document navigation and correct preview sources |
| nestedWorkspace, agentNavigation | Workspace navigation, conversation return and drafts |
| sidebarDensity | Toolbar/list layout and typography |

Other scripts under `test/support/` are developer probes or historical experiments;
their presence does not imply CI coverage. Promote a useful probe with an explicit
behavioral contract and synthetic fixture. Do not restore retired renderer APIs.

## Failures

Scripts run in separate processes without retries, with a five-minute per-script
bound and an overall suite budget (seven minutes on macOS, eighteen on Linux),
leaving time for failure uploads before the job deadline. Unrun tests are reported
as failures if that budget is exhausted. Results are saved after each test. A failed script does not hide later failures. Each browser context records a
Playwright trace and captures screenshots before closing; continuous DOM snapshots and trace filmstrips
are recorded only on macOS to avoid competing with Linux software rendering;
Linux retains action traces, final screenshots and logs; console and process logs
are retained. Passing-script diagnostics are deleted. Abrupt crashes or timeouts
may leave only logs, since a dead browser cannot finalize its trace.

CI uploads failed browser diagnostics and the Vite log for seven days. Per-script
results and timings are retained for fourteen days, including successful runs.
Open a downloaded trace with `node node_modules/playwright-core/cli.js show-trace
path/to/context-1-trace.zip`. All fixtures must remain synthetic: traces contain DOM
and network data. Do not use this diagnostic harness against a real vault.

Fix flakes by waiting for observable state, preserving the behavior being tested.
Keep dedicated idle/animation tests; avoid forced clicks and blanket retries.
A temporary quarantine requires a tracked cause, owner, expiry, and coverage for
critical behavior elsewhere. A rerun alone is not a repair.

## Compatibility and stress

`compatibility.yml` runs nightly at 08:23 UTC and through Actions → compatibility
→ Run workflow. For CI/runner changes, choose the feature branch in that dialog
or use `gh workflow run compatibility.yml --ref <branch>` before merging.
It runs the browser suite on macOS (`browser (macos-latest)`: every regression
in `test/browser-suite.json`, plus the macOS packaging/install tests in
`test/siteBuild.test.ts`; Chromium, not native WKWebView or packaged-desktop
parity), the exact same browser command on Linux, and the watcher regression 100
times. Linux software rendering took 11m39s on the repair baseline,
versus 2m15s on macOS, so it is outside the ordinary PR gate with a 20-minute bound.
No assertions were deleted to make this split. Functional Linux browser contexts
use reduced motion; macOS retains normal motion, and the consent transition test
explicitly covers both preferences. Toolbar idle timers and interaction assertions
remain active. A current 30-script run with normal motion spent 202 seconds in
sidebar navigation and exhausted the 18-minute suite budget after 24 passing
scripts. The reduced-motion run completed all scripts in roughly 14 minutes and
exposed fixture races, now repaired by atomic transient-state observation, an
explicitly controlled detail failure, and a creation revision matching the real server. Timeouts and retries are unchanged.
Reproduce the preference locally with `CI_BROWSER_REDUCED_MOTION=reduce node bin/ci-browser.cjs`.

Failures on main open or refresh one issue assigned to `elsehow`, who triages it
on the next working day. Close it only after understanding the cause and verifying
a passing main run. Scheduled coverage must not become an ignored red dashboard.
Manual runs on feature branches provide validation without creating main incidents.

## Follow-up boundaries

`native.yml` runs on macOS for desktop sources/resources, supervisor/native
lifecycle entry points, native harness changes, and its own workflow, plus manual
requests. It pins Rust 1.95.0 and Bun 1.3.9 and uses the committed Cargo lockfile.
Run the same check locally with `sh bin/ci-native.sh`. It compiles the native
binary, runs Rust lifecycle tests (readiness/ownership, shim behavior, startup
failure, process-group shutdown), and tests the native containment harness's
result classification. It prepares only the development resource stub, does not
launch the app, and has a separate 30-minute build budget. The two ordinary
merge checks remain unchanged; native-changing PRs must also pass this workflow.
The path-filtered native status is not an unconditional repository-wide required
check, since unrelated PRs do not start that workflow.

Packaged-app/WKWebView smoke tests and extension-store validation remain distinct
work under #959 and the release issues. Native compilation is not release acceptance.
For the packaged check, use the offline disposable macOS VM procedure in
[test/support/native-smoke/vm/README.md](../test/support/native-smoke/vm/README.md).
Record the candidate BUNDLE engine identity and verify first run (including missing
git), navigation, two-vault switching, restart recovery, lifecycle, shutdown children,
and install/update. Do not substitute a HOME override or a browser preview for
that containment/acceptance evidence. This workflow publishes nothing. Browser and fake-bundle
packaging tests are useful evidence, not substitutes for testing the shipped app.

After two weeks, review Actions job durations and the timing artifacts: p50/p95
feedback time, runner consumption, flaky failures, and diagnosis time. Add matrix
entries or conditional jobs only for a documented gap. Keep useful inexpensive
unit coverage; optimize the measured bottleneck.
