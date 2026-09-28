# Native idle profile — 2026-09-20

The next optimization target is **attention animation repainting the full graph**.
The viewer-engine telemetry alone would miss most of this cost: the native WebKit
renderer and GPU helper dominate CPU in the visible app.

## Measurements

Installed app 0.7.17, engine `3151980` (the local performance build, before the
telemetry commit), macOS 26.6.2 / arm64. No prompts were submitted, conversations
changed, or vault content written by the profiler. Existing background jobs were
left running. The app had 35 saved Pilots, none in the working phase, four unresolved
question notifications, and no unread sources at the time of inspection. Counts
were read without retaining titles, messages, paths, or identifiers.

Two 30-second samples, each with 15 native measurements and no process churn:

| Process group | CPU, run 1 | CPU, run 2 | Physical footprint, run 2 |
| --- | ---: | ---: | ---: |
| WebKit renderer(s) | 52.4% | 51.5% | 973 MiB |
| WebKit GPU helper | 38.0% | 36.4% | 197 MiB |
| Native shell | 3.1% | 3.0% | 39 MiB |
| Engines / supervisor | 1.2% | 2.1% | 1,633 MiB |
| Network / other helper | 0.2% | 0.2% | 16 MiB |
| **Total** | **95.0%** | **93.3%** | **2,858 MiB** |

CPU is percent of **one core**, so 100% is one fully busy core. The GPU-helper
column is that process's **CPU time**, not hardware GPU utilization. Native
`powermetrics` GPU timing requires administrator access; it was unavailable without
a password and was not enabled. Physical footprint includes compressed memory;
summed RSS is also recorded but can double count shared pages. Neither is live
JavaScript heap size, and these short samples do not establish a memory leak.

CoreGraphics confirmed one on-screen main window before and after both valid
samples. The app was not the active application; these are **visible, unfocused**
samples, not validated foreground-active samples. Other applications were running,
so these are diagnostic observations on this machine, not controlled power tests.

## Isolating the animation path

The production-bundle synthetic harness uses 4,166 nodes / 12,008 edges and blocks
all external requests. In otherwise identical six-second visible-window samples:

| Synthetic state | Animation callbacks | Renderer task time |
| --- | ---: | ---: |
| No attention indicators | 0 | 2.1 ms |
| One pending-question indicator | 360 | 699 ms |

The attention selector breathes by changing opacity, but `LinkGraph.svelte` sets
`smoothAttention` and keeps the **whole canvas** rendering at display refresh rate.
This is separate from actual model execution. The earlier idle harness had no
pending questions or unread indicators, so it correctly measured a quiet graph but
missed this common state. `PROFILE_ATTENTION=1` now covers that state. The synthetic
result isolates this rendering path; it does not prove that every native CPU sample
is exclusively caused by it or predict a native CPU saving from a particular fix.

Recommended fix: render attention indicators on a separate composited layer and
leave the graph canvas asleep when geometry is unchanged. Preserve the visible
attention signal, reduced-motion behavior, and camera/selection interaction. Then
repeat the synthetic and native profiles. A frame-rate cap could reduce cost, but
would still repaint thousands of unrelated nodes for an opacity animation.

## Window-state limits

Hidden/closed measurements were attempted but **discarded**. AeroSpace's
`automatically-unhide-macos-hidden-apps = true` prevents a stable macOS app-hide
condition. Accessibility sometimes reported no windows / foreground status while
CoreGraphics still showed the main window on screen and the native app API reported
it inactive. Close attempts through Accessibility and AeroSpace did not produce a
consistently verified off-screen state. Low-CPU intervals associated with those
unverified states are not reported as hidden/closed results. The window-manager
configuration was not changed. The app window and original focus were restored.

A clean native session without automatic unhide is still needed for the full
foreground/hidden/closed comparison. A several-hour memory-retention test also
remains outstanding. The current finding is enough to prioritize graph animation
before broadening telemetry or interpreting current viewer-only CPU as app idle CPU.

## Reproduction and accounting

- `python3 test/support/profileNativeIdle.py --calibrate` compares native CPU
  counters with this process's CPU clock. It measured a ratio of 1.00014. The Mach
  timebase on this Mac is 125/3 ns per tick; treating raw counters as nanoseconds
  would undercount CPU by 41.67×. The calibration prevents that mistake.
- `python3 test/support/profileNativeIdle.py --pid <desktop-pid> --seconds 30`
  reads processes sharing the shell's resource coalition, including WebKit helpers
  whose parent is launchd. It does not collect process arguments or vault content.
  Coalition attribution uses a private macOS diagnostic interface and fails closed
  if unavailable; it is not shipped as production telemetry. Short-lived processes
  between samples and startup CPU of newly observed processes can be missed; the
  output flags process churn, so avoid treating such runs as complete CPU totals.
- Compile `test/support/profileNativeWindow.swift` and run it with the desktop PID
  before and after each phase. It reports only active/hidden flags and count of
  on-screen, layer-zero windows taller than 100 pixels. This heuristic is for the
  current BigBrain main window; it does not inspect page visibility or occlusion.
- Build the UI, then run `PROFILE_IDLE=1 PROFILE_ATTENTION=1 node
  test/support/graphWorker.browser.cjs`. Omit `PROFILE_ATTENTION` for the control.
  `PLAYWRIGHT_MODULE` can name an existing Playwright installation. The harness's
  background-tab visibility still reports visible; do not use it as hidden evidence.

Accounting interfaces: Apple's [process resource structures](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h)
and [coalition structures](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h).
Only aggregate measurements are retained in the [result JSON](2026-09-20-native-idle.json).
