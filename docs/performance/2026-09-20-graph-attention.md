# Attention animation — 2026-09-20

Fixes #837. Attention brackets now paint on a separate canvas with a compositor
opacity animation. They use the graph's existing projected coordinates, visibility,
zoom, and invalidation. Pending questions and unread sources no longer keep the
graph's animation loop awake. Working/draft indicators and other graph animations
retain their existing behavior. Reduced motion uses static opacity 0.8; removing
the last attention item clears the layer and stops its CSS animation.

## Measurements

Synthetic production UI: 4,166 nodes, 12,008 edges, one pending question. No vault,
model, engine, or integration access. These are short measurements, not evidence
of long-session memory behavior or a prediction of whole-app savings.

| Measurement | Before | After |
| --- | ---: | ---: |
| Chromium graph callbacks / six seconds | 360 | 0 |
| Chromium renderer task time / six seconds | 699 ms | 3.7 ms |
| Native WebKit coalition CPU (% of one core) | 54.60% | 1.52% |
| Native WebKit renderer CPU | 19.59% | 0.47% |
| Native GPU helper **CPU** | 32.57% | 0.29% |

Chromium baseline is the earlier [native-idle investigation](2026-09-20-native-idle.md).
Patched unread-source attention also produced zero callbacks and 3.9 ms task time.
Browser assertions check visible painted brackets, changing opacity, zoom alignment,
non-interception of pointers, reduced motion, and clearing attention after a data
update. Its background-tab probe reports `visible`, so it is not hidden-window evidence.

The new native before/after comparison uses a standalone WKWebView loading the same
synthetic production bundle, first at b506aa1, then with this patch. Both windows
were verified visible, unfocused, and not hidden before and after their roughly
16-second samples. Both had no process churn. The existing coalition profiler
includes WebKit helpers. Page probes confirmed visible state and active attention
with changing opacity in the patched page; its callback count stayed at 107 during
a separate focused sample. Focus/size changes can still schedule graph frames.

This isolates the rendering fix in macOS WebKit. It is not a rerun of the installed
Tauri app on the private vault, and it does not measure hardware GPU utilization.
The earlier real-app 93–95% CPU finding remains a separate observation. Physical
footprint is retained in the [raw aggregate results](2026-09-20-graph-attention.json),
but differing allocator/cache state makes it unsuitable for claiming a memory fix.
An initial patched sample with process churn was discarded.

## Reproduction

Build each revision with `bun run web:build` in an isolated worktree. For Chromium:

```
PROFILE_IDLE=1 PROFILE_ATTENTION=1 node test/support/graphWorker.browser.cjs
PROFILE_IDLE=1 PROFILE_UNREAD=1 node test/support/graphWorker.browser.cjs
```

Set `PLAYWRIGHT_MODULE` if Playwright is installed outside the checkout. The default
(no profile flags) still checks cold-worker rendering and cached remounts.

For native testing, serve that same fixture with `PROFILE_SERVE=1 PROFILE_ATTENTION=1
node test/support/graphWorker.browser.cjs`. It binds only 127.0.0.1:53918 and returns
synthetic responses. Compile `test/support/profileGraphWebKit.swift` with `swiftc`
into a disposable `.app/Contents/MacOS/GraphProfile`; its Info.plist needs
`CFBundleExecutable=GraphProfile`, a unique `CFBundleIdentifier`, and
`NSAppTransportSecurity.NSAllowsLocalNetworking=true`. Launch it with `open -n`.
The helper writes only frame/visibility/attention counters to
`/tmp/bb-graph-webkit-state.json`. Wait for layout to settle, verify native state
with `profileNativeWindow.swift`, and sample with
`python3 test/support/profileNativeIdle.py --pid <pid> --seconds 15`.
Restart the test app between bundles. Close it and the fixture server afterward.
