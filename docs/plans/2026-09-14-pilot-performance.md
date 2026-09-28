# Pilot keyboard latency profile

## Composer typing (September 15)

The same 4,030-node graph was replayed with fabricated Pilot HTTP responses;
no model requests or vault changes. A 60-character Playwright typing replay
with CPU sampling took 3,226 ms before and 60 ms after the change. The second
animation frame following input measured median / p95 of 50.5 / 101.2 ms before
and 15.1 / 20.5 ms after. This is a rapid synthetic replay, not a typing-speed
or physical display latency guarantee.

Each edit to `chat.drafts` invalidated `HomeView.visibleGraph`, cloning the vault
and repeating selection reconciliation. CPU time accumulated in `withPilotChats`,
HomeView, and Svelte proxy property access rather than text rendering. The draft
now travels as a separate `pilotDraft` prop through SystemGraph to LinkGraph,
which only repaints the small label. Graph structure no longer depends on each
keystroke. Backend draft persistence remains debounced at 350 ms.

## Session placement (September 15)

Pilot collision spacing also treated every hidden vault node as an obstacle.
On a 4,034-node graph it displaced three sessions to around y=-600 even though
their anchors were at y=36 and y=-95. Spacing now reserves the overview and all
session context endpoints. Pilots remain separated from those visible nodes and
one another, while hidden nodes no longer force them outside the constellation.
The same three sessions landed at y=-190, -284 and -184. Existing settled vault
positions are preserved. A dense-background regression covers this distinction.

## Opening and closing

Chrome, Vite development build, real vault: 4,030 nodes and 11,390 edges.
Each action creates or cancels an empty session; no model request is made.
The CPU profiles cover Shift-Enter and Esc after the initial graph has settled.

| Action | Before: DOM / next paint opportunity | After: DOM / next paint opportunity |
| --- | --- | --- |
| Shift-Enter, no context | 66 / 80 ms | 56 / 68 ms |
| Esc, no context | 2,587 / 2,609 ms | 53 / 72 ms |
| Shift-Enter, two selected nodes | 2,751 / 2,760 ms | 90 / 96 ms |
| Esc, two selected nodes | 2,674 / 2,685 ms | 92 / 104 ms |

“Next paint opportunity” is the second animation-frame callback after keydown,
not a claim of exact physical display presentation. DOM timing uses a mutation
observer to detect the composer appearing/disappearing. These are individual
measurements on the same local graph, with CPU sampling enabled.

A repeat using the checked-in profiler measured 61 / 70 ms for the empty case
and 246 / 104 ms with context (next paint opportunity). That opening included
about 146 ms in WebGL `loseContext`; the D3 stall remained absent. Rendering and
GPU cleanup still contribute variable latency, so these results do not imply
every transition fits within a single frame.

## Cause

`withPilotChats` changes graph structure for session nodes and context edges.
`LinkGraph.build` consequently passed every node to `cachedCompactOverview`.
Both adding a Pilot node and temporarily showing an isolated session changed
the solver inputs, invalidating the single-entry overview cache. Esc invalidated
it again when restoring the vault graph. Each miss ran D3 collision relaxation
over thousands of background nodes synchronously on the browser's main thread.
The context profile attributed over four seconds across both actions to D3
collision force application and quadtree traversal. Waiting for backend creation
was already removed; this remaining delay was browser layout computation.

## Fix

`graphDisplayLayout.ts` settles and caches the underlying vault graph independently
of Pilot overlays. `layoutBase` retains that graph across session selection,
isolation, context changes and removal. Session nodes use settled context positions
plus a local offset. Opening or closing a Pilot no longer changes solver inputs
or rearranges the vault. Actual vault updates and layout-control changes still
invalidate the cache. The after profiles contain no D3 simulation during the actions.

`test/graphDisplayLayout.test.ts` asserts that opening, closing, isolation and
context updates share one solve, while real graph changes still recompute.
`test/support/pilotSession.browser.cjs` covers the immediate composer, queue and
Esc interactions under a delayed backend.

## Reproduce

With the app and local backend running on :5198:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright \
PILOT_PROFILE_PREFIX=/tmp/pilot-after \
node test/support/pilotProfile.browser.cjs
```

This prints graph size, CPU hot spots, long tasks and keyboard timing, and writes
`/tmp/pilot-after-empty.cpuprofile` and `/tmp/pilot-after-context.cpuprofile` for
Chrome DevTools. It briefly creates then discards empty sessions in the real vault.

## Settings close regression (2026-09-15)

Returning from Settings remounts HomeView. With existing Pilot sessions, the
initial null vault graph briefly produced a session-only graph, which replaced
the cached 4,039-node overview with a three-node layout. The cached vault then
arrived and synchronously reran D3 collision/layout work. CPU profiling measured
3.64 seconds from Esc to two painted frames; most samples were in D3 forces.

HomeView now waits for the cached vault graph before adding session overlays.
The same measurement was 264 ms with no force-solver samples. The browser
regression `test/support/themeSettings.browser.cjs` checks that both Esc and X
reuse the cached full layout, using a fabricated 4,000-node graph and sessions.
