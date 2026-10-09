# Unified GPU graph prototype

Historical experiment log. The completed renderer is now the production path
in this branch; see [current architecture](graph-renderer.md). References below
to `graphProbe`, the original renderer, and prototype limitations describe the
experiment at that date, not the current implementation.

## What it tests

One WebGL2 context renders the graph in three instanced passes: edges, nodes,
and labels, plus an optional instanced activity pass and a fullscreen edge resolve pass that caps accumulated opacity. Node and edge geometry stays in static GPU buffers. A floating-point
texture contains old and new depth/opacity states and shared node positions. A selection change computes
the existing memory-domain relationships and uploads transition targets once;
vertex shaders perform projection and interpolation each frame. Interrupted
node transitions start from the current interpolated state. Text is cached in
a 2× label atlas, not measured or rasterized every frame. The renderer stops
requesting frames after motion settles unless an active status signal needs animation.
Optional glow, shadow and trail batches share the same node buffers (see below).

The prototype uses the existing display-layout and memory-theme layout functions,
real graph data, full backing resolution, and production j/k navigation. It can
also pick nodes with the pointer. The other graph canvases are not mounted when
this renderer is active.

## Deliberate visual/interaction limits

This is not visual parity. It preserves circles/diamonds/triangles, graph edges,
selection rings, memory/agent labels, theme colors and depth transitions. It
omits modifier selection/exclusion and exact original spring motion/terrain.
Optional glow, height shadows and approximate color trails are available for
comparison; they remain disabled by default.
Cached GPU labels cover home memories, selected/hovered nodes and agent drafts,
with bounded collision placement and theme-colored backing plates. Exact label
placement still differs from the original. Edge transition targets retain their
interpolated state on interruption. Selected-neighborhood motion and emphasis remain approximations.
The home camera, visible membership, hierarchy opacity and settled depth now
match the original renderer; pixel-level parity is still incomplete. These differences contribute to the measured gain; it cannot be
attributed solely to merging canvases. The prototype must not become a default
until required visual and interaction behavior is restored and remeasured.

## Local comparison

Start Vite in `web/ui` on port 53490. Put a local graph snapshot at
`web/ui/.profile-local/graph.json` (gitignored and never copied into production).
Open:

`http://127.0.0.1:53490/sidebar-workbench.html?profile=1&graphSnapshot=/__profile_graph.json&graphProbe=unified`

The panel switches between Original and Unified GPU prototype, and runs the
same 24-key j/k walk. Keep the window size fixed. The snapshot supplies graph
geometry; other API responses and note content are fabricated. The version and
commit badge identifies the preview source.

For automated visible WebKit comparison:

```sh
HEADLESS=0 PROFILE_FLOAT=1 PROFILE_PROBES=baseline,unified \
  PROFILE_GRAPH_FILE=/tmp/home-walk-graph.json REPEATS=3 \
  PROFILE_OUT=/tmp/unified-comparison.json node test/support/profileHomeWalk.cjs
```

AeroSpace floats only the newly created test browser window, and the harness
rejects changed viewports. Timings measure rAF cadence and JavaScript callback
execution, not GPU completion or hardware input latency.

## Initial measurements

2026-09-22, visible Playwright WebKit 26.6, 3790×1183 at DPR 1, 4,290 nodes and
11,910 edges. Three repeats with alternating order:

| Metric | Original | Unified prototype |
| --- | --- | --- |
| p95 frame interval, each run | 22, 22, 22 ms | 18, 18, 18 ms |
| Median frame interval | 17 ms | 17 ms |
| p95 animation callback | 8 ms | 1 ms |
| Median animation callback | 7 ms | below the 1 ms timing resolution |
| Visible graph canvases | 4 | 1 |

This is a meaningful reduction in main-thread work and an improvement in the
slow-frame tail. It does not demonstrate 120 Hz performance or a finished
quality-preserving replacement. Next: preserve exact scene targets/transition
curves, add the missing effects incrementally, and repeat on the native app.

Baseline: main `beb54dc4`, version 0.7.27, plus the profiling and prototype
commits. Installed app at the start was `a3ab7c96`; the preview is not that binary.

## Verification

`node test/support/unifiedGraph.browser.cjs` checks the production shell, one
canvas, j/k selection and interruption, one state upload per selection, four
base draws plus an optional activity draw, sleep with static signals, DPR 2 resize, graphics-context recovery and
the comparison panel. Production build inspection must confirm the prototype
shader and local snapshot are absent. No production resolution or renderer
selection is changed.


The prototype also exposed a shell resize-delivery loop at startup. AppShell now
retains observer targets by identity, schedules measurement on the next frame,
and writes its layout variable only when the value changes. This fix applies
to both renderers and is exercised by the production-shell resize tests.

The initial visible measurements above preceded the shell observer fix. A final
visible rerun was rejected because AeroSpace did not expose a uniquely identifiable
new test window; the harness did not touch another window or accept that run.
Final-code performance is therefore also checked headlessly, and the Safari
comparison panel remains the way to judge the actual display.

Final-code headless WebKit repeats (same dimensions and graph): original p95
frame intervals 21, 19, 20 ms; prototype 19, 19, 19 ms. Callback p95 remained
8 ms versus 1 ms in every run. The strongest repeatable result is reduced
main-thread drawing work; end-to-end cadence gains are smaller and depend on
host/display conditions. Both medians remain 17 ms.

## First home-parity pass (2026-09-23)

The overview now uses `GraphHierarchy`, `applyOverviewAttention`,
`memoryHomeDepth`, and `fitCamera`, with bounds taken from visible home nodes.
It restores the memory/evidence depth layers, peripheral fading, node sizing
with zoom, filled home memory diamonds, memory-only resting labels, and weighted
edge widths/salience. Selection still uploads targets only when it changes. The shared `revealCamera`
calculation centers the selected node in the available room, so a home landmark
cannot disappear behind the preview card. Camera retargeting now uses the velocity-preserving spring described below;
it remains a prototype rather than an exact copy of the original flight.

Edges accumulate into a full-resolution RGBA framebuffer within the same GL
context. One fullscreen resolve applies the original `edgeContrast` opacity
ceiling. Dense intersections can no longer turn into opaque ink. The framebuffer
is resized with the backing canvas and rebuilt after context loss. This adds a
GPU pass and a full-resolution texture; it does not add another DOM canvas or
restore per-frame CPU geometry work.

`node test/support/unifiedGraphParity.browser.cjs` uses a fabricated 320-node
graph and compares original/GPU home membership, hierarchy opacity, depth and
projected positions (within 0.5 CSS pixels) at 1440×1280 and 1912×1280, DPR 2.
It also samples screenshot pixels to ensure ordinary foreground nodes really
render, and reads GPU pixels to verify that 200 overlapping edges remain below
the opacity ceiling after resizing and renderer recreation. The same home
comparison passed on the 4,290-node saved snapshot with `PROFILE_GRAPH_FILE`.
Both the parity test and profiler now wait for the original renderer’s
asynchronous overview worker to finish: a stable initial frame can still be
its temporary server-position layout. Earlier timing runs used a fixed warmup
and did not explicitly verify worker completion.

At this stage, remaining visual differences included edge endpoint trimming/density and hover
masks, label placement/collision/backplates, antialiasing,
trails, bloom, shadows and the original motion curves. The screenshot comparison
covers a resting home view, not complete visual/interaction parity.

Provenance: v0.7.27, baseline `beb54dc4`, continuing `perf/unified-graph` / PR #928.
Installed engine when this pass began: `dafcebc8` (built 2026-09-23 00:35:32 UTC).
The preview is the experiment, not that installed binary.

The first same-browser performance run after this pass showed nonstationary
baseline timings (p95 25/47/65 ms versus GPU 18/18/20 ms). Fresh-browser cases,
alternating order, reduced that drift: original p95 28/23/22 ms, GPU 18/18/20 ms,
at 3790×1183 DPR1 in headless WebKit with the saved graph. Callback p95 was
9/8/8 ms versus 1/1/1 ms. These runs preceded the selection-recentering refinement.
Use `REPEATS=1 PROFILE_PROBES=baseline` or `unified` in separate processes to
reproduce the fresh-browser control. Cadence is not a GPU-completion measurement
and these results do not establish native-app or 120 Hz performance.

Final-code checks after selection recentering (`69aa23f9`), three fresh-browser
GPU runs: p95 frame intervals 18/20/22 ms, median 17 ms in each, callback p95
1 ms in each. The preceding fresh original runs were 28/23/22 ms (callback p95
9/8/8 ms). The cadence ranges overlap; the robust result is low main-thread
rendering cost, with closer home visuals. Final-code screenshot inspection and
production-shell selection-centering, home-parity and GPU pixel-cap regressions
all passed. This remains a dev-only experiment.

## Hover, selection, connections and theme ground (2026-09-23)

Pointer hover now lights the node, shows its title and feeds the production
Quick Look panel through `sidebar.hoverId`. Clicks commit `app.graphView` and
open the existing note/conversation flow; a lifted node keeps its original hit
footprint. Blank clicks return home, and selected nodes are centered in the
space remaining beside an open sidebar. Escape/pointer exit clear hover.

Edge visibility is now a transition record in the same GPU state texture as
node depth and opacity. Selection/hover changes compute targets once; rendering
still submits four draws per frame. The existing `memoryDomainEdge` restores
inspected direct-to-second-hop connections while retaining a memory's resting
spokes. Ordinary-node selection shows existing edges within its direct
neighborhood. Pilot-context geometry is no longer dropped wholesale. Edges
retarget from their displayed state rather than abruptly switching root masks.
No inferred connections are added.

The canvas explicitly uses `var(--bg)`, and palette observation includes
`data-theme` changes. `unifiedGraphInteractions.browser.cjs` verifies hover Quick
Look, lifted-node clicks, committed selection, inspected/neighbor edges, blank
reset, and actual background screenshot pixels in default, dusk and phosphor.
The home parity test explicitly fits both renderers after their layout completes;
the original's initial camera can otherwise race asynchronous layout sizing.

At this stage, remaining interaction differences included modifier-based multi-selection and
exclusion, pan/zoom/drag (restored below), and exact hover-history timing. This pass does not
claim complete interaction parity. Installed engine remains `dafcebc8`; the
experiment continues from main `beb54dc4`, v0.7.27.

## Softer focus motion and dense selections (2026-09-23)

Camera, node depth/opacity and edge opacity now use a critically damped spring
with a softer tail. Retargeting retains both position and velocity, including
rapid reversals during j/k navigation. GPU uniforms carry analytic spring
coefficients; velocity records share the existing state texture. No per-node
CPU animation loop was added. From rest, motion reaches roughly 85% at 240 ms
and 99.8% at 600 ms, then sleeps after 1000 ms. Reduced motion still snaps.
These are transition durations, not frame latency.

Ordinary selections no longer promote second-hop nodes. Neighbor-to-neighbor
edges reuse the original faint background weights (ordinary edges get 0.06
before salience), while spokes and inspected connections remain emphasized.
The original degree factor `1 / sqrt(max(1, degree / 30))` now lowers the merged
edge opacity ceiling for dense focus states. It is applied once, at resolve,
to avoid unnecessarily attenuating every spoke twice. Memory-domain edge rules
and real graph topology remain intact.

The home menu no longer shows an empty General bucket. If uncategorized agents
exist, the row is named “Uncategorized agents”; moving the last agent into a
memory removes it. Existing agents and unseeded conversation creation remain
reachable when that row is present.

Validation adds spring continuity/settling tests and a synthetic 64-neighbor
clique: second-hop nodes remain quiet, neighbor edges remain faint, and actual
GPU crossing pixels obey the density-adjusted ceiling. The production-shell
category test covers empty-row removal, uncategorized agents, live category
moves and return navigation. Existing graph lifecycle, interaction and fitted
home parity checks also pass.


## Live status signals (2026-09-23)

The existing node pass now draws the original agent phase vocabulary: idle and
answered/active triangles, hollow draft/working/interrupted/failed triangles,
the draft caret, working arc, pause and failure marks, and circular selection
rings. Needs-you agents and unread sources wear breathing attention brackets.
Pending arrivals and legacy live sessions regain their activity rings. Draft
text is cached in the label atlas and drawn below the agent. Status animation
uses a time uniform: still one canvas/context and four draws per frame, with no
per-frame node traversal, geometry upload or text rasterization. Reduced motion
keeps the signals visible and static; the loop sleeps when no active signal or
transition needs it. Animated context-edge dashes are not restored in this pass.

Metadata changes update the existing renderer, preserving camera, selection and
hover. Phase/attention changes upload the node attributes once; changed draft
text or titles refresh the label atlas. Read receipts recompute overview
visibility without rerunning layout. Structural changes still rebuild geometry.
An edgeless-graph regression also caught the fullscreen resolve borrowing an
empty edge attribute buffer; the resolve now explicitly uses the default VAO.

`unifiedGraphStatus.browser.cjs` exercises phase changes through the production
shell's fabricated chat state, unread receipts and needs-you state, preserved
camera/resources, reduced-motion sleep, and return to idle. Actual GPU pixels
are compared with the original Canvas indicators in light and dusk themes;
working motion, draft text, attention corners and legacy/pending spinners are
checked in readbacks. Existing home parity, dense selection, interaction and
lifecycle checks still pass. No live vault writes or private fixtures are used.

Fresh headless WebKit checks at 3790×1183 DPR1, using the same 4,290-node snapshot:

| Run | Median interval | p95 interval | Intervals >25 ms | Callback p95 |
| --- | --- | --- | --- | --- |
| Before status pass | 17 ms | 18 ms | 3 / 272 | 1 ms |
| After status pass | 17 ms | 18 ms | 4 / 273 | 1 ms |
| After, with extra working agent and 12 unread sources | 17 ms | 18 ms | 3 / 272 | 1 ms |

These single-run checks show no observed cadence regression at this workload;
they do not establish native-app or 120 Hz performance, GPU completion time,
or idle power usage. Resting active signals now keep the GPU drawing, unlike
the previous prototype that omitted them. The extra-signal snapshot is local
only. Baseline remains v0.7.27 / `beb54dc4`, installed engine `dafcebc8`.


## Animated agent connections (2026-09-23)

Active agent context links now use the original 7 CSS px dash / 7 px gap,
1.2 px accent stroke, and 28 px phase advance per 850 ms. Connections are faint
at rest (0.18 opacity), stronger on agent hover/selection (0.85), and mark the
connected endpoint with an accent dot. Reduced motion freezes the dash offset.
Roster-active agents retain moving context between turns, as in the original;
closed agents lose the activity treatment. Agent-priority views also retain
the original foreground treatment of active agents' actual connections.
Historical links do not become invented context links.

One optional foreground batch draws the lines and endpoint dots after the
background-edge resolve, preserving their color and contrast independently of
the dense-edge opacity cap. There is still one canvas/context; an animated
scene takes five draws, otherwise four. The existing edge-state texture now
also carries activity opacity, fading ordinary ink out underneath a context
link. Projection, endpoint trimming, dash motion and hover emphasis stay in
the shaders. Metadata/selection changes update buffers and targets, never the
animation loop. Context-flag changes preserve renderer identity and focus.

`unifiedGraphActivity.browser.cjs` checks actual moving dash pixels, 14 px
periods, hover emphasis, identical reduced-motion frames, live context removal,
historical-edge exclusion and real-shell active/closed agent transitions.
Status and lifecycle checks now account for between-turn context animation and
the optional fifth batch. Home parity and dense-overlap checks remain intact.

Fresh headless WebKit j/k walk at 3790×1183 DPR1 on the same saved graph:
17 ms median / 19 ms p95 frame interval, 3/273 intervals over 25 ms, and 1 ms p95
animation callback. The previous status-only spot check was 17/18/1 ms. This
small single-run difference is not evidence of a repeatable regression, and
neither run measures native input latency or establishes 120 Hz performance.

## Direct navigation and camera handoff (2026-09-23)

Dragging the background pans; wheel and trackpad pinch zoom around the world
point under the cursor, including its depth when pointing at a node. Dragging
a node moves it and its labels/connections together. An 8 CSS px threshold
separates a click from a drag, and pointer capture retains the gesture outside
the canvas. Escape, lost capture and window blur release it without opening
the node. Double-clicking blank space fits home. A new selection, including
j/k navigation, smoothly resumes automatic focus from the manual camera.

The camera now lives in an independent, tested controller. Its spring has its
own clock, so hover/status retargeting cannot restart camera motion. Position
and logarithmic zoom both ease into automatic focus and fit; dragging tracks
the hand directly. Wheel zoom smoothing is described below. Reduced motion snaps automatic moves.

Node world positions occupy the unused channels of the existing velocity
texture records. All GPU passes read the same position by node index. A drag
updates one texel per pointer move, without rebuilding edge or label geometry.
Only the dragged node's height is held during the gesture; other depth springs
continue. Dragged positions are temporary preview layout, not vault changes,
and reset when structural graph changes rebuild the renderer.

`unifiedGraphCamera.test.ts` checks depth-aware projection inversion, anchored
zoom, continuous camera ownership/handoff and reduced motion. The production
AppShell navigation browser test passes in WebKit and Chromium at a fixed
1440×1000 DPR2 viewport. It checks panning, wheel/pinch anchoring, actual GPU
pixels after node dragging, click suppression, Escape, j/k handoff, eased
double-click fit and resize. Existing interaction, lifecycle, status, animated
connection, home-parity and dense-selection browser checks pass, as do lint,
engine typecheck, viewer check and production build.

A fresh headless WebKit j/k walk at 3790×1183 DPR1 on the saved 4,290-node graph
measured 17 ms median / 19 ms p95 frame intervals, 3/273 intervals over 25 ms,
and 1 ms p95 animation callbacks: the same values as the preceding connection
pass. This single-run check does not measure input-to-display latency, GPU
completion, native 120 Hz performance, or sustained drag performance.
Baseline remains v0.7.27 / `beb54dc4`; installed engine remains `dafcebc8`.

## Smooth wheel zoom and Escape home (2026-09-23)

Wheel and trackpad pinch now retarget a critically damped logarithmic zoom
spring. Events accumulate against the pending destination and preserve zoom
velocity. Each frame adjusts translation to keep the cursor's world point
anchored at its depth. Moving the cursor reanchors from the current view;
starting a drag or returning to focus cancels pending zoom continuously.
Reduced motion applies zoom immediately. The camera alone animates, with no
additional scene uploads or drawing passes.

The production shell's existing home/reset action now reaches the GPU renderer.
Escape restores fitted home framing even when selection was already empty,
and clears hover and any captured drag. The shell retains its existing editor
and dialog Escape handling. Double-click fit shares the same renderer reset.

Camera tests cover intermediate anchored frames, accumulated wheel input,
velocity continuity, drag/focus interruption, settling and reduced motion.
The AppShell browser regression checks zoom progressing across actual frames,
fixed cursor anchoring and Escape both from an unselected zoomed home and a
selected drag. This follow-up does not add a new performance measurement;
the preceding j/k results are from the direct-navigation commit.

## Readable labels (2026-09-23)

Labels retain the original sparse vocabulary: home memory landmarks, selected
and hovered nodes, and agent drafts. Ordinary selected nodes now keep their
title after the pointer leaves. The atlas uses 11 CSS px text, truncates long
titles, and remains cached between content/focus changes. A rounded backing
plate uses the theme ground and the original degree-dependent 0.45–0.85 opacity;
active agent titles use the activity color. Plates and text share the existing
label draw, replacing the separate DOM hover tooltip.

A separate placement helper prioritizes selection, hover and drafts, tries
below/above the node, stays within the viewport and hides lower-priority
collisions. The candidate pool is bounded (64 home memories plus focus and
draft entries, at most 100 total), with at most 64 visible labels. Only this
small set is projected and placed on the CPU each frame; the graph still uses
GPU projection. Changed label offsets/opacity update a small instance buffer;
text is not measured or rasterized per frame. Visible memory labels participate
in hit testing, so their titles are usable targets as in the original.

Unit tests exercise focus priority, collisions, viewport edges and invisible
candidates. The production-shell label test clicks a memory title and reads
actual GPU pixels to verify plates in light/dark themes and cached text reuse.
Existing hover/selection, agent status and direct navigation regressions pass.

## Native desktop measurements after labels (2026-09-23)

The installed Tauri executable (bundled engine revision `dafcebc8`) loaded this
worktree's production AppShell, v0.7.27 / `9e4fdd84` plus the label changes. Its
sidecar used a temporary, empty git vault with no integrations and separate
ports; the UI used the saved 4,290-node / 11,910-edge snapshot and fabricated
API responses. The installed application and real vault were not replaced.

Apple M4 Pro, 16 GPU cores; Dell U4025QW configured at 3840×1620 / 120 Hz, with
a 7680×3240 scaled backing surface. The test viewport was fixed at 3790×1183
CSS px, native DPR 2 (7580×2366 graph canvases), without resolution reduction.
Each fresh native process walked twelve j then twelve k inputs, 180 ms apart,
after completed layout and warmup. No screenshots ran during measurement.

| Native renderer | Median interval, three runs | p95 interval, three runs | Callback p95 | Intervals >25 ms |
| --- | --- | --- | --- | --- |
| Original | 29 / 31 / 27 ms | 45 / 45 / 42 ms | 8 / 9 / 8 ms | 102/149, 121/136, 99/154 |
| GPU, including labels | 17 / 17 / 17 ms | 28 / 28 / 29 ms | 1 / 1 / 1 ms | 15/256, 16/257, 17/254 |

The first five accepted cases alternated original/GPU order. The last GPU
case was rerun after DOM-focus rejection; macOS process/window checks confirmed
it was foreground, unhidden and visible before and after the walk, despite
WKWebView reporting no DOM focus. All accepted cases retained their viewport,
DPR and document visibility throughout. Early sizing-race runs were rejected,
not averaged into the table.

A blank native webview control on the same viewport/display measured 17 ms
median / 17 ms p95 over 262 intervals, with none over 25 ms. This is a cadence
control, not a production-shell performance result. It suggests that reaching
120 Hz needs investigation of native webview scheduling as well as graph cost;
it does not establish a universal WebKit limit. The immediate rendering target
is to bring the GPU's slow-frame tail closer to the observed ~16.7 ms cadence.

These are requestAnimationFrame intervals and callback timings, not GPU finish
times or input-to-photon latency. Keys are dispatched to the real navigation
handlers, not generated by hardware. The native path is now automated:

```sh
PROFILE_GRAPH_FILE=/tmp/home-walk-graph.json REPEATS=3 \
  PROFILE_OUT=/tmp/native-home-walk.json node test/support/profileNativeHomeWalk.cjs
REPEATS=1 PROFILE_PROBES=blank PROFILE_OUT=/tmp/native-blank.json \
  node test/support/profileNativeHomeWalk.cjs
```

The harness requires the worktree Vite server on 53490, macOS Swift tooling,
AeroSpace, and permission for System Events to size its own test window. It
identifies that window by the launched PID, floats it, sizes it through AX,
and waits for the webview to report the requested dimensions. A scratch vault
is required because this baseline's setup door reports a null supervisor and
fails the shell's startup identity check (tracked separately in
[issue #930](https://github.com/elsehow/BigBrain/issues/930)). Runs end well before the first
scheduled gardener tick; cleanup terminates only this launch's shell/supervisor.
Raw local evidence: `/tmp/native-home-labels-full.json` and
`/tmp/native-home-labels-controls.json`. No private snapshot is committed.

## Optional visual effects (2026-09-23)

The workbench now offers `graphEffects=none|glow|shadows|trails|breathing|all` and
`graphTheme=default|dusk`. The profiling panel exposes both selectors
and records them in its result. Effects default to `none`; this is an opt-in
comparison, not a production renderer or default-style change.

Each effect adds one instanced draw using the existing node geometry and state
texture. Zero-opacity sprites are culled before rasterization. There are no new
canvases, full-screen blur targets, history textures or per-node CPU animation:

- Glow is a bounded, soft halo on selected/hovered nodes in dark themes. Unlike
  the original it includes memory landmarks and stays steady instead of
  breathing, so it does not keep an otherwise idle graph animating.
- Shadows use the original positive-height spreading/fading formula beneath
  lifted sources and agents, with the theme's mark color.
- Trails estimate camera/depth velocity from the previous frame and draw three
  faint RGB silhouettes, offset by at most 3 CSS px per side (see the later tuning below). They fade with depth,
  vanish with reduced motion and clear on the first stationary frame. This is
  an approximation of the original spring-following trails: it does not retain
  world-position history for individual node dragging. Retargets, resizes and
  long frame gaps reset history instead of leaving stale streaks.

GPU pixel tests verify independent glow/shadow/trail output, no light-theme
glow, no stationary/reduced-motion trails, state texture reuse and idle sleep.
The production AppShell test verifies theme/preset application and restoration
after context loss. Existing navigation, status, label and geometry regressions
continue to cover the same rendering path with effects disabled.

Native comparisons use the same scratch-vault and fixed-viewport harness:

```sh
REPEATS=3 PROFILE_PROBES=unified PROFILE_THEME=dusk \
  PROFILE_EFFECTS=none,glow,shadows,trails,all \
  PROFILE_OUT=/tmp/native-effects-dusk.json node test/support/profileNativeHomeWalk.cjs
```

Each case starts a fresh native process. Order reverses on alternating repeats;
the harness rejects a mismatched theme/preset and checks that requested effects
actually issued draws during the walk. Measurements retain full DPR2 backing
resolution and use the same saved graph and fabricated APIs as above.

Results on the same 3790×1183 / DPR2 native viewport (v0.7.27,
`0c2ab3c7` plus the optional-effect changes), dusk theme:

| Effects | Accepted runs | Median interval | p95 interval per run | Intervals >25 ms, pooled |
| --- | --- | --- | --- | --- |
| none | 3 | 17 ms | 29 / 29 / 27 ms | 48/760 (6.3%) |
| glow | 3 | 17 ms | 34 / 27 / 27 ms | 48/760 (6.3%) |
| shadows | 3 | 17 ms | 28 / 28 / 30 ms | 50/756 (6.6%) |
| trails | 3 | 17 ms | 32 / 34 / 26 ms | 49/758 (6.5%) |
| all | 2 | 17 ms | 34 / 28 ms | 33/504 (6.5%) |

Callback p95 was approximately 1 ms for every accepted run. Effect counters
confirmed that the intended extra batches ran. The small sample shows no large
slowdown in this j/k workload, but it does not establish zero GPU cost: the
slow-frame tail varies, and none of these choices fixes it. All-on p95 was
28–34 ms versus 27–29 ms with effects off. This remains rAF cadence/callback
measurement, not input-to-photon latency or a power test.

Fourteen trials were accepted. The last all-on dusk trial, its retry, and a
subsequent light-theme control lost native foreground and were rejected.
Thus there are two accepted all-on repeats, three for each individual effect
and none, and no accepted native light-theme comparison in this pass. Light
and dark visual/GPU regressions both pass; native light-theme cost remains
unconfirmed. No rejected run enters the table. Raw local accepted evidence:
`/tmp/native-effects-dusk.json`. Defaults remain off pending visual preference.


### Slightly stronger color trails

After visual review, maximum channel separation increased from 1.8 to 2.4 CSS
px and trail opacity from 0.35 to 0.40. The sprite bounds grow by the same
0.6 px to preserve the antialiased fringe. This changes neither draw count nor
state uploads; stationary and reduced-motion behavior remain unchanged.
GPU effect regressions pass. The native measurements above precede this
strength adjustment and should not be read as a fresh measurement of it.

## Excavation hover and working halos (2026-09-23)

Hover now leaves the pointed node at its sampled depth instead of moving it to
an arbitrary focus plane. Its immediate neighbors stay at least as high as
when entered; unrelated nodes descend. `GraphHoverHistory` supplies the original
visit generations: older neighborhoods sink 3.5 units per generation, capped
at 13, while unvisited nodes recede 80 units. Per-node visit heights preserve
already elevated neighbors; unseen depths are relative to the lesser of their
resting depth and the exploration surface. This is intentionally stricter
about keeping the pointed node still than the old shared-surface approach.

Depth changes use a 350ms cosine ease. Leaving holds the layers for the original
2500ms, then returns them with the original 1800ms cosine timing. Reentering
interrupts continuously and retains earlier visits, including during return.
Explicit selection, Escape/home reset and reduced motion clear the history.
The selected camera retains its focus depth while a neighborhood is inspected;
hover takes over an in-flight camera at its displayed position. Explored nodes
retain readable opacity during the hold rather than fading to the background.
Agents remain on their dedicated foreground plane.

CPU target/state uploads happen on interaction or once when return begins;
node/edge projection and depth interpolation remain on the GPU. Depth has its
own pair of analytic coefficients so edge/opacity springs remain independent.
A timer wakes an otherwise sleeping graph after the hold. Tests cover actual
AppShell pointer stability and timer wake, first-degree retention, shallow
history layers, cosine midpoint/end, interruption, selected-camera stability,
Escape/reset, reduced motion and zero per-frame state uploads during return.

The chromatic pass now puts red and blue on opposite sides of the opaque node,
rather than stacking all three faint colors behind it. Offsets cap at 3 CSS px
per side, with stronger tint/opacity and matching sprite bounds. Pixel tests
require separately visible red and blue fringes outside the solid node, not
merely a difference from the no-effect image. They still disappear at rest.

`graphEffects=breathing` (also included in `all`) adds an accent-colored halo to
working agents in light and dark themes. Its four-second cycle gently varies
radius and opacity, freezes under reduced motion, and stops when work ends.
It shares the existing working-status animation loop and adds one instanced
batch only while a working agent is visible; no new canvas or blur texture.
The workbench's “Working agent demo” (`graphWorking=1`) makes one fabricated
agent work so the effect can be inspected without contacting an agent.
GPU pixel tests verify breathing on both themes, static reduced-motion output,
no halo for answered agents and live phase changes through AppShell.

These changes supersede the earlier one-sided trail tuning. Earlier native
measurements do not measure this combined revision.

A fresh native j/k off/all comparison with the same fabricated working agent
was attempted at 3790×1183 / DPR2, but the control lost foreground and was
rejected. There are no accepted new native timing results for this revision.
Functional, GPU pixel, typecheck, lint and production-build checks pass.


## Home continuity and legible excavation (2026-09-23)

Selection now preserves the focus and its direct neighbors at their individual
home depths. Other nodes recede relative to their own home layer: at most 60
units on selection, with intermediate memory-domain depths scaled accordingly.
This replaces the shared focus plane, which lifted direct evidence by 70 units
and compressed unrelated nodes onto a different silhouette. Focus preserves the
current zoom and camera framing; automatic camera motion only reveals a node
outside the safe viewport beside the sidebar. Escape still fits home.

Node ink no longer globally switches from home styling to full black when any
node is selected or hovered. Only the focus and nearby/explored nodes gain ink;
other nodes keep their home styling, with additional depth-dependent fading.
The shader blends this ink and an exponential depth fog in the existing node
pass, making receding layers lighter. Unselected memory markers remain hollow
in both home and focus views. Memory labels stay below their node on hover so
they remain under the pointer long enough to click. Selection keeps more background state opacity
than before; its final ink remains quiet without losing the home outline.

Focus and hover movement now use a 700ms sinusoidal velocity cycle, with zero
velocity and acceleration at rest. A decaying incoming-velocity term preserves
motion through interruptions; the pointed node is explicitly pinned. The
2500ms hover-out hold remains, followed by the same sine-shaped cycle over
1800ms. Both depth and ink return to home. Wheel/pinch retains its responsive
logarithmic spring. No new draw batches or textures are needed; ink endpoints
reuse existing node attributes and upload once per retarget, never per frame.

Validation covers production AppShell first-selection continuity and safe-frame
reveal, home and manually chosen zoom retention, direct-neighbor geometry,
actual GPU depth-shading pixels, interrupted background velocity, buffer reuse,
and restoration of home ink after delayed return. Existing navigation, status,
activity, labels, dense-edge and effects checks remain required. Original/GPU
fitted home geometry is checked at two DPR2 viewports. The saved local graph was
also inspected at a fixed 1912×1280 CSS viewport / DPR2. Production output keeps
the same main asset hash (`index-BduA2Ch9.js`); this remains development-only.
No new native performance claim accompanies this visual revision.


## Faster committed navigation (2026-09-23)

Committed selection (j/k and clicks) now uses a 280ms sinusoidal transition for
node depth, ink, edges and camera reveal, down from 700ms. Hover excavation keeps
its 700ms motion, 2500ms hold and 1800ms return; explicit camera fit and wheel/pinch
retain their existing timing. CPU sampling and GPU uniforms share the active
duration, and interruptions sample the old curve before switching timing.
Production AppShell checks require selection to settle within 350ms, including
a j/k reversal after 120ms. Camera tests verify velocity continuity when a fast
focus interrupts a slower move. Hover-history and navigation regressions,
lint, engine/UI typechecks and production build pass. This is animation timing,
not a new frame-latency measurement.


## Focus glide and explicit hover neighborhoods (2026-09-23)

The 280ms sinusoidal selection ease felt abrupt. Committed selection now uses
the earlier critically damped spring shape with a .018/ms rate: about 83% of a
rest-to-target move is complete at 180ms, 96% at 280ms and 99% at 370ms. A small
settling tail ends at 650ms. This provides an earlier response and a softer
finish; interrupted moves preserve velocity. Hover excavation, delayed return,
wheel zoom and the home-camera fit retain their previous curves. Named focus
and exploration motion profiles keep CPU sampling, shader uniforms and camera
timing consistent without treating a duration value as a curve selector.

Hover explicitly emphasizes the pointed node and all first-degree neighbors,
even outside a committed selection's neighborhood. Their ink blends to full
foreground contrast instead of being attenuated by background weight/depth fog;
hover spokes gain emphasis too. Past neighborhoods retain their shallower depth
history but relinquish active highlighting. Degree attenuation considers both
the selected and hovered roots, keeping dense hover stars within the existing
edge-opacity cap. Emphasis endpoints occupy unused attributes in the existing
node buffer; there are no extra draw calls, textures or per-frame state uploads.

Tests cover the new response/settling shape, continuity when switching motion
profiles, production-shell j/k arrival and rest after a quick reversal, unchanged
hover history, full-contrast neighbor GPU pixels outside a selected neighborhood,
quiet second-hop nodes, emphasized spokes, navigation and dense edge limits.
Effects and animated-agent connections are checked against the reused buffer.
The saved graph is inspected at 1912×1280 DPR2. Lint, engine/UI typechecks and
production build pass; no new native frame-timing measurement is claimed.


## Duplicate-review graph occlusion regression (2026-09-23)

A screenshot exposed a shared shell defect, not a GPU-only problem. HomeFolds
had no positioned stacking layer, while the production sidebar places the
fixed graph at z=0. The graph could paint over review controls and receive their
pointer events. EntityFolds also mixed its warning tint with transparent, so
correct stacking alone still let graph marks show through the review surface.
The installed engine `dafcebc8` and fetched main `beb54dc4` have these same rules.

HomeFolds now sits above the graph at z=1; its warning wash blends into the
opaque theme background. In the sidebar shell it starts below the measured
fixed toolbar. This shared CSS fix applies to both renderers and ships with the
normal UI; the experimental renderer remains development-only.

`test/support/graphFoldPanel.browser.cjs` mounts production AppShell, then seeds
two fabricated proposal groups using the workbench API. The check fails before
the fix because the graph intercepts the radio control. It verifies hit testing,
toolbar clearance, opaque computed paint, and identical review pixels with the
graph visible or hidden in web-blue, light and dusk themes for both baseline and
unified renderers. Canonical selection, accept, reject, removal of the empty
panel and subsequent graph navigation are exercised without live vault writes.
Lint, engine/UI typechecks and production build pass.


## Consistent active agents and clear connection endpoints (2026-09-23)

Active agents now retain all their actual incident connections through home,
committed selection and hover exploration. Visibility no longer depends on the
selected memory's neighborhood, a context flag or an agent-priority view. Direct
endpoints are revealed outside the compact overview without expanding another
hop. The existing roster predicate keeps answered agents active between turns;
explicitly closed agents lose the special treatment. Their normal memory/evidence
depth, ink and overview eligibility replace the former unconditional foreground
plane. Archiving and reactivation retarget in place, including during excavation,
without replacing the renderer or clearing unrelated exploration history.

The red dot inside a memory diamond was an activity-edge endpoint marker, not an
underlying agent. It is removed. Dashed links terminate at the glyph boundary;
the foreground activity batch now needs one instance per link instead of two.
There are no new passes, textures or per-frame geometry uploads. This supersedes
the earlier selection-gated context rules and endpoint-dot description above.

The saved-snapshot workbench also had a fabricated agent whose context referred
to a sample-only source. It now uses an existing snapshot memory, so the preview
has a real connection to draw. Production topology is not synthesized.

The activity regression reproduces foreground fading during j/k before the fix.
It now checks every active agent through j/k and hover in production AppShell,
archive-during-hover depth release, reactivation, snapshot fixture wiring, static
GPU geometry, actual moving 7px dashes/gaps, stronger hover contrast, reduced-motion
pixel stability and a clear memory center. Status-shape comparisons account for
archived depth fading; the effects fixture explicitly distinguishes an active
agent from a historical one. Status, effects, hover-history, continuity and
navigation browser checks pass, along with 27 targeted unit tests, lint, engine
and UI typechecks and the production build. A fixed 1912×1280 CSS / DPR2 saved-graph
preview was inspected. This is functional/visual validation, with no new native
frame-timing claim.

Preview provenance: v0.7.27, perf/unified-graph based on fetched main beb54dc4;
installed engine remains dafcebc8. The renderer remains development-only. The
production main assets remain index-CvkvqaIf.js and index-MUl-rnPf.css.
