# Home navigation profiling

From an isolated checkout with root and `web/ui` dependencies installed:

```sh
cd web/ui
bunx vite --host 127.0.0.1 --port 53490 --strictPort
```

In another terminal at the checkout root:

```sh
node test/support/profileHomeWalk.cjs
```

The harness uses Playwright WebKit, the production `AppShell` through
`/sidebar-workbench.html`, and fabricated API responses. It walks twelve `j`
then twelve `k` presses, 180 ms apart. It compares 1883×1183 and 3790×1183
viewports at full device pixel ratio, reversing case order
on alternate repeats. The default is three repeats. Raw intervals, callback
durations, canvas dimensions, browser version and preview provenance go to
`/tmp/home-walk.json`.

Headless mode avoids AeroSpace resizing windows. The harness explicitly sets
the viewport and samples its dimensions throughout each walk; any size change
invalidates the run. `HEADLESS=0` enables a visible window. `PROFILE_ENGINE=chromium`
uses installed Chrome as a secondary comparison. Neither mode is the installed
Tauri app; headless cadence does not measure native on-screen compositing cost.
The rAF sampler also keeps requesting frames, so this is an active-navigation
benchmark, not an idle-power measurement. DPR defaults to 2 for both sizes;
`PROFILE_DPR` overrides it. `PROFILE_WIDTH` restricts the run to one width and
`PROFILE_EFFECTS=none,all` compares effect presets without changing resolution.

To replay the current graph size without pointing development code at the vault:

```sh
curl --fail -H "Authorization: Bearer $(cat ~/.config/bigbrain/viewer-session-4747)" \
  http://127.0.0.1:4747/api/graph -o /tmp/home-walk-graph.json
PROFILE_GRAPH_FILE=/tmp/home-walk-graph.json \
  PROFILE_OUT=/tmp/home-walk-vault.json node test/support/profileHomeWalk.cjs
```

This reads a graph snapshot from the running install. Keep it local: it contains
vault metadata. The browser replays its topology and positions but uses fabricated
note content and API responses. Browser requests to live API endpoints are blocked.
It therefore measures rendering at vault scale, not real note-fetch latency.

For the built production entry and native Tauri cadence:

```sh
bun test/support/buildGraphPreview.mjs
PROFILE_BUILD_DIR=/tmp/bigbrain-graph-built REPEATS=3 \
  node test/support/profileNativeHomeWalk.cjs
```

The native harness launches an isolated scratch-vault window, floats and resizes
only that window, and rejects runs with changed viewport, hidden document, or
lost foreground. It keeps full backing resolution and records the installed
shell's BUNDLE revision separately from the preview commit. Do not use the
computer during its short foreground walk. `PROFILE_PROBES=blank` measures a
blank native cadence control. Built production checks use the shipped effects.

`node test/support/profileAgentOpen.browser.cjs` separately measures quick-nav
Enter to chat panel/history paint opportunities in WebKit and Chromium. It
compares cached history with an explicitly cold, fabricated 400ms request;
this is not real-vault server latency or physical input-to-photon latency.
`agentOpen.browser.cjs` covers loading, errors/retry, and Escape during fetch.

Compare Safari Inspector recordings without screenshots to assess compositing.
Do not infer GPU time from JavaScript callback durations or rAF intervals.

The results and commands below are the historical experiment log. Retired
renderer/isolation/half-resolution flags require the corresponding old commit.

## Initial experiment, 2026-09-22

Preview: version 0.7.27, main baseline `754eeba0` plus this experiment. Main
advanced by one commit (`a1e15a82`) during the run. The installed desktop bundle
was `a5163f7c`, so this is not an exact installed-app reproduction.

Headless WebKit 26.6, DPR 1, snapshot with 4,290 nodes and 11,910 edges,
three runs per condition:

| Viewport | Canvas scale | Median frame interval | Per-run p95 frame interval |
| --- | --- | --- | --- |
| 1883×1183 | 1 | 17 ms | 20, 20, 19 ms |
| 3790×1183 | 1 | 16–17 ms | 22, 22, 23 ms |
| 3790×1183 | 0.5 | 17 ms | 21, 20, 21 ms |
| 1883×1183 | 0.5 | 17 ms | 19, 19, 19 ms |

Median animation callback duration was 7 ms in every condition. Half-resolution
showed a small tail improvement, but did not reproduce or resolve the much larger
fullscreen compositing penalty from the user's Safari traces. No production
resolution change is justified by this experiment alone. Screenshot capture was
disabled; dimensions and backing-pixel changes were checked automatically.


## Compositing experiments, 2026-09-22

Current-main baseline `beb54dc4`, version 0.7.27, plus the profiling commits.
Installed desktop at the start of this follow-up was `87a82be3`. These are
production-shell previews, not the installed binary. Four canvases are the
edge, trail, main and attention layers of one graph, not duplicate graphs.

Visible WebKit 26.6 at a verified 3790×1183, DPR 1, graph snapshot of 4,290
nodes and 11,910 edges. Three repeats with reversed order on alternate runs:

| Probe | Per-run p95 frame interval |
| --- | --- |
| Original | 23, 23, 24 ms |
| Sleep empty edge layer | 25, 23, 24 ms |
| Disable backdrop blur | 26, 22, 22 ms |
| Hide attention layer (diagnostic only) | 25, 22, 21 ms |

No reliable improvement. Single-run edge/trail hiding also showed no clear
benefit. A direct-canvas shortcut was discarded because the selected-workspace
walk needs its mask. Empty-edge sleeping preserves exact output in eight real
WebGL readback comparisons (including resize and empty-to-visible transitions),
but remains dev-only pending a useful performance result.

```sh
HEADLESS=0 PROFILE_FLOAT=1 PROFILE_TIMELINE=1 \
  PROFILE_PROBES=baseline,idle-edges,no-blur,hide-attention \
  PROFILE_GRAPH_FILE=/tmp/home-walk-graph.json \
  PROFILE_OUT=/tmp/home-compositing.json node test/support/profileHomeWalk.cjs
```

`PROFILE_FLOAT=1` floats only the newly identified Playwright window, leaving
other windows and AeroSpace configuration alone. The window closes after each
case. Viewport measurements throughout the walk still gate acceptance.
`PROFILE_WIDTH` selects the width when using `PROFILE_PROBES`.

`PROFILE_TIMELINE=1` records raw WebKit Timeline events via an internal
Playwright bridge, pinned to the repository's Playwright version. It fails if
that bridge is unavailable. This is not Safari's exported JSON format. Some
Composite events are flushed unfinished at recording stop and have misleading
multi-second durations; do not aggregate them as completed composites. The
results above use rAF cadence, not those incomplete events.

### Try the comparison in Safari

Copy a local graph snapshot to `web/ui/.profile-local/graph.json`. This directory
is gitignored and outside Vite's public directory; its contents cannot be copied
into a release by Vite. A serve-only middleware exposes the snapshot at
`/__profile_graph.json` on this localhost preview.

Open `/sidebar-workbench.html?profile=1&graphSnapshot=/__profile_graph.json` on
port 53490. The comparison panel selects an experiment and runs the same 24-key
j/k walk in Safari. Keep the window size fixed and compare repeated runs; the
panel rejects resized runs. Its simulated keyboard events test the app's
navigation handlers, not hardware input latency. Graph geometry comes from the
snapshot, and note contents/API responses are fabricated. The browser shows a
version/commit badge; there is no installed-app modification.

Options that hide layers or remove blur are diagnostic, with deliberate visual
changes. **Original** and **Sleep empty edges** preserve resolution and content.
The panel itself occupies a small opaque rectangle, so compare panel-enabled
runs with one another, not directly against older traces.

Verification: `node test/support/graphEmptyEdges.browser.cjs` checks GPU pixel
identity and the production-shell panel's walk and resized-run rejection.
