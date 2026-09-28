# Search and resource profile — 2026-09-19

Search now reads small, indexed source headers instead of parsing complete source-event JSON for candidate metadata. Ranking, filtering, snippets, and result limits are unchanged. The other measurements identify graph reconstruction and its memory footprint as the larger remaining targets.

## Search improvement

Five warm samples per query, on a private snapshot of the real vault. These are backend `scanSurface` timings, not typing-to-paint timings.

| Query class | Before median | After median |
| --- | ---: | ---: |
| Common term | 131.5 ms | 30.4 ms |
| Phrase | 118.7 ms | 19.7 ms |
| Topic term | 85.4 ms | 18.8 ms |
| One-letter prefix | 103.7 ms | 72.0 ms |
| Two-letter prefix | 158.4 ms | 64.2 ms |
| Source-filtered term | 68.0 ms | 14.8 ms |
| Entity-only term | 1.4 ms | 1.2 ms |

Instrumentation showed SQL reading `envelope.kind` and `envelope.source` from large `event_json` values dominating common searches. `sources` now stores those two generated values and a covering header index. Search/header queries explicitly use that index. The columns have no declared affinity, preserving JSON value types and the existing treatment of missing/non-string metadata.

The projection schema advances from 9 to 10. Its existing recovery path rebuilds this disposable database from the immutable logs. That upgrade took approximately **8.3 seconds once** on the snapshot; ordinary synchronization subsequently took about 18 ms. The original logs are not changed. An additional migration test exercises an actual version-9-shaped table with the new columns/index removed.

For a controlled comparison, the benchmark replays the original JSON-extraction queries against the same rebuilt database, with the new covering-index hints removed. All **42 result digests matched**, including order, scores, snippets and filters. Rebuilding an older snapshot projection can itself change search statistics, so comparing only the pre-migration database would not isolate the query change.

No debounce or UI ranking changes were made. Remaining prefix-query cost includes assertion search and per-entity evidence queries; a one-letter query generated 130 entity-assertion reads in the initial trace. This is a possible later optimization, but would need care to preserve ranking and evidence.

## Graph startup and memory

Eight forced graph invalidations/rebuilds retained the same 4,166 nodes and 12,008 edges. A separate first pass measured 2.55 seconds to construct the graph and 3.75 seconds for a persisted-layout miss. Repeated construction remained roughly 1.8–2.0 seconds; persisted layout hits were approximately 1.3–1.6 ms. The browser worker change does not remove these backend costs.

The final memory run forced GC, yielded to the event loop, and forced GC again between rebuilds. JavaScriptCore-reported heap size stayed around **215 MB**, with approximately **559–561 thousand objects**. RSS grew from approximately **1.12 GB to 1.58 GB**. Earlier runs plateaued around 1.8–2.1 GB, illustrating why RSS alone should not be treated as a retained-JavaScript leak measurement. This short run did not show steadily growing live objects; it does show a large process footprint. It does not rule out leaks in other paths or over longer sessions.

The next backend investigation should reduce repeated event-file/Markdown reads during `buildAssertionGraph` and the full records retained for graph/evidence views. Do not add another cache until ownership and invalidation are clear. There is no backend graph or memory optimization in this change.

## Idle observations and remaining limits

- With the isolated backend benchmark sitting idle for ten seconds, CPU consumption was only tens of milliseconds. This excludes the production supervisor, watchers, integrations, and model processes.
- After the synthetic graph settled, the production renderer scheduled **zero animation-frame callbacks** over six seconds, with approximately **2 ms of main-thread task time** and roughly 46 MB of JavaScript heap in the windowed browser run. Its APIs and event stream were mocked; this is a renderer observation, not whole-app power consumption.
- Both headless and windowed automated Chrome continued reporting `document.visibilityState === "visible"` after switching tabs. Those background samples are therefore **not valid hidden-window measurements**. Native WebKit hidden/closed-window behavior, GPU consumption, and the full process tree still need a dedicated measurement (or the proposed opt-in telemetry). No change to installed app state was made to force those conditions.

## Validation and reproduction

- Full suite: **1,991 passed, 3 opt-in tests skipped, 0 failures**. The initial restricted run could not bind loopback test servers; the full rerun with local binding allowed passed.
- TypeScript, targeted lint, and diff checks passed. The shared browser harness still confirmed worker completion and cached reload behavior.
- `test/support/profileSearchResources.ts <marked-snapshot-root>` measures search SQL, graph rebuilds, GC-aware memory and isolated idle CPU. `BB_PROFILE_SEARCH_ONLY=1` skips the memory/idle phases; `BB_PROFILE_LEGACY_HEADERS=1` replays the original header SQL. `BB_PROFILE_MEMORY_ONLY=1` skips search sampling.
- `PROFILE_IDLE=1 node test/support/graphWorker.browser.cjs` measures settled renderer work using synthetic data. `PROFILE_HEADFUL=1` opens a temporary browser window. Always inspect the reported visibility state. `PLAYWRIGHT_MODULE` can locate an existing Playwright installation.
- The snapshot excluded credentials, attachments and provider configuration. SQLite copies used read-only backups; file copies were not an atomic transaction across the whole vault. No model inference or telemetry uploads occurred. The snapshot and private intermediate artifacts were removed after preserving aggregate measurements.

[Aggregate measurements](2026-09-19-search-resources.json)
