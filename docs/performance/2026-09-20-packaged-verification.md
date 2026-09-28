# Packaged telemetry and native idle verification

Tested engine `a0cd9b3` (the merged #864/#866 refactors) in a release-mode,
ad-hoc-signed Tauri app bundle. This is a local candidate, not a published release
or an installer/updater test. `codesign --verify --deep --strict` passed. The app
used its bundled Bun, engine, and freshly built viewer. An explicit engine path
pointed at that same bundled engine to leave the user's CLI shim untouched.

## Scope and fixture

All writes used synthetic scratch vaults: 1,200 filed source insertions, 1,200
assertions across 120 entities, one memory note, and a synthetic owner declaration.
The native instance used a separate copy and separate HTTP ports. A fixture
connection flag bypassed provider onboarding; no provider login or live model
turn was tested. Claude's configuration was isolated and worktree protection
prevented Codex plugin refresh. No real vault was modified.

The telemetry instance temporarily used a fresh opt-in identity; original
installation consent was backed up and restored. The native profiling instance
started with telemetry disabled. These are verification events, not customer
engagement. They can be identified by release `a0cd9b3` and the batch timestamp
`2026-09-20T23:59:21.546Z`.

## Telemetry

- The packaged collector started with sharing off and reporting configured.
- Opt-in used the normal local endpoint and unmodified five-minute timer.
- Real search, graph, and note HTTP requests succeeded. A production-viewer
  browser smoke test used the search UI and opened a result: no page errors,
  and exactly one `note_opened` action appeared in the collector.
- PostHog project 619325 received six events: two `desktop_resources` (foreground
  and background), three `desktop_operation` (search, graph, note), and one
  `desktop_usage`. All carried `release=a0cd9b3`, `platform=darwin`, `arch=arm64`.
- All five saved Performance queries returned data after a forced refresh.
  Both Engagement queries returned the single synthetic note-open installation.
  No dashboard definitions were changed.
- Opt-out was observed for over 320 seconds while search requests continued.
  Sharing stayed off, the queue remained empty, delivery stayed idle, and a final
  hosted query still returned exactly the original six events with no later
  timestamp. The original consent file was restored byte-for-byte afterward.
- Pilot acceptance deduplication is covered by collector tests; this pass did
  not submit a live Pilot prompt or verify provider response latency.

Dashboards: [Performance](https://us.posthog.com/project/619325/dashboard/2116605)
and [Engagement](https://us.posthog.com/project/619325/dashboard/2116606).

## Native resources

Launch Services (`open -n`) gave the candidate its own process coalition. Each
reported measurement spans 30 seconds with 15 samples and no process churn.
Native CoreGraphics/AppKit checks confirmed window state before and after.
The native viewer requested the real graph endpoint successfully.

| State | CPU, percent of one core | Summed physical footprint |
| --- | ---: | ---: |
| Visible, unfocused | 1.779% | 1,022.978 MiB |
| Window closed, engine running | 1.417% | 1,016.011 MiB |
| Reopened, visible and unfocused | 1.533% | 1,050.965 MiB |

The closed sample had zero on-screen main windows at both boundaries and on a
subsequent check. A PID-targeted macOS reopen event restored one active, visible
window; the engine also continued serving search successfully.

An app-hide request returned false and left the window visible. Its recorded
sample is **not evidence of hidden-app behavior**. Closing the window provides
the valid off-screen measurement here. AeroSpace settings were not changed.

A first attempt launching the executable directly inherited unrelated processes
in its resource coalition and was discarded. An initial malformed synthetic
assertion fixture also failed before measurement; it was corrected with explicit
timestamps. Neither attempt is included in the reported CPU figures.

CPU calibration against Python process CPU time gave a ratio of 1.00013. GPU-helper
CPU is included; hardware GPU utilization is not measured. Physical footprint
includes compression and can double-count shared pages. These short synthetic
samples neither establish memory leaks nor quantify a speedup from the earlier
real-vault baseline. The earlier attention-specific synthetic comparison remains
separate evidence; this fixture does not reproduce its pending-Pilot questions.

## Checks and remaining scope

Engine typecheck, lint, Svelte check (zero warnings/errors), production viewer
build, generated-plugin check, and eight telemetry/plugin-version tests passed.
The local route test required loopback networking outside the filesystem sandbox.

Long-session retained-memory investigation and hardware GPU profiling remain
explicitly deferred. Recheck the actual published artifact during the next release
smoke test; this report establishes readiness of the packaged candidate, not
successful distribution or automatic plugin refresh on customer machines.
