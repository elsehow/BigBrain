# Graph renderer

The production `AppShell` uses one `LinkGraph` and one WebGL2 canvas. The old
canvas hierarchy and the development renderer switch have been removed.
`SystemGraph` maps app selection, home previews, note-link probes, and sidebar
space onto that component; it does not choose a rendering implementation.

`web/ui/src/lib/graph/` separates the renderer, shaders, camera controller,
motion curves, label placement, effect settings, status encoding, and view
normalization. Layout and relationship algorithms remain pure shared helpers.
The display layout is cached independently of transient agent nodes, so opening
a conversation does not rerun the vault layout solver.

Geometry stays in GPU buffers. Selection and activity changes upload targets;
shaders interpolate depth and opacity. Camera movement updates uniforms. Labels
share a cached texture atlas, and overlapping ordinary edges resolve through
one opacity-capped texture. Optional effect passes share node buffers. The
approved effects are enabled by default at full device pixel ratio. Reduced
motion disables motion effects; idle rendering sleeps unless status needs it.

Home j/k previews pan smoothly to the selected node without changing the home
zoom. The camera reserves the actual menu width and quick-look panel height.
Pointer exploration retains the hovered node's footprint while unrelated nodes
recede. Prior neighborhoods linger before a cosine return. Manual pan and zoom
own the camera until a new selection or Escape; Escape restores the home fit.

Active agents and their real context links remain visible between turns.
Archived agents resume natural depth. Activity lines animate only for working
agents. There are no synthetic endpoint dots that could resemble another agent.
All selection, hover, probe, and label hits respect explicit exclusions.

Graph-facing panels share `--panel-bg` (78% theme background) and `--panel-blur`
(6px). Sidebar contents are transparent over a single backplate, so fills do
not stack into an opaque surface. Duplicate review remains above graph input.

Quick-nav opens the chat synchronously. Preview and chat share a deduplicated
history request, with session-specific loading, errors, and retry in the panel.
A late response updates cached history without reopening a dismissed chat.

## Verification

The normal preview is `/sidebar-workbench.html`, using the production shell.
`bun test/support/buildGraphPreview.mjs` additionally compiles the exact shipped
`main.ts` entry alongside an isolated fabricated-API entry at
`/tmp/bigbrain-graph-built/graph-production.html`. This fixture is not part of
the normal release build. Native profiling serves those built assets through
the installed Tauri shell against a scratch vault, without replacing the app.

See [profiling](home-walk-profiling.md) for commands and timing limits, and
[selection](graph-selection.md) for gestures. The
[prototype log](unified-graph-prototype.md) records the earlier experiments;
its retired flags and limitations are historical.

## Final promotion measurements, 2026-09-23

Renderer commit `79349c4d`, v0.7.27, including main `beb54dc4`. Native shell
engine BUNDLE `dafcebc8` (built 2026-09-23T00:35:32Z). The installed shell loaded
the compiled production fixture against a scratch vault; the installed app was
not replaced. Geometry replay contained 4,290 nodes and 11,910 edges with
fabricated note/chat APIs. Both foreground runs held 3790×1183 CSS px at DPR2,
all effects enabled, including the restored j/k camera glide and panel blur.

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| Median rAF interval | 17 ms | 17 ms |
| p95 rAF interval | 32 ms | 27 ms |
| Intervals over 25 ms | 16 / 254 | 16 / 254 |
| p95 animation callback | 1 ms | 1 ms |
| Dispatched key to next rAF, median / p95 | 13 / 48 ms | 11 / 47 ms |

A blank native control at the same dimensions measured 17 ms median / 18 ms
p95, with no intervals over 25 ms. These are frame-scheduling measurements,
not GPU timers or physical input-to-photon latency. The graph is cheap on the
animation thread, but its tail is not sustained 120 Hz motion. No fresh compiled
old-renderer comparison was made; earlier original/GPU comparisons remain in the
prototype log with their build and timing limitations.

Quick-nav history was profiled separately in browser AppShell fixtures. A
controlled 400 ms cold request delayed the old panel's paint opportunities to
459 ms (WebKit) / 437 ms (Chromium). With eager opening, the panel appeared at
41 / 46 ms; history arrived at 441 / 437 ms. Warm opens were 34–48 ms across the
before/after runs. These single samples isolate the blocking wait and do not
claim a faster server response or measure the user's real transcript cost.

The local suite passed 1,979 tests with 9 optional integration skips. Lint,
typechecks, production builds, compiled-entry browser checks, and the targeted
GPU/interaction regressions pass. The only full-suite failure during development
was the generated extension token copy, fixed using `bun run design:sync`.
GitHub Actions could not start because its account payments/spending limit
blocked runners; that is separate from local validation.
