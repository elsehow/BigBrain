# Real-vault scale profile — 2026-09-19

The largest opportunity is graph startup, especially the synchronous browser display layout. Ordinary note switching and cached briefings are substantially cheaper. No production behavior changed in this pass.

## Measurements

Disposable snapshot: 11,781 log files, 1,208 Markdown notes, 4,930 projected assertions, 724 projected entities. Rendered graph: 4,166 nodes and 12,008 edges.

| Operation | Observed time |
| --- | ---: |
| Projection synchronization | 30 ms |
| Initial backend graph build | 3,110 ms |
| Backend layout with unmatched persisted cache | 4,202 ms |
| Browser graph first draw, fresh tab and cold server graph, persisted server layout already warmed | 6,137 ms |
| Long browser task during that first draw | 3,514 ms |
| Same-tab graph reloads in the initial series | 240 / 223 ms |
| Subsequent typical-note switches | 41–42 ms |
| Subsequent dense-note switches | 81–94 ms |
| Briefing cache hits, typical note | 14–19 ms |
| Briefing cache hits, dense note (629 assertions, 656 links) | 44–48 ms |
| Repeated backend search, three query classes | 101–164 ms |
| First common-term backend search | 994 ms |
| Search input to rendered results, one sample per query class | 273 / 286 / 433 ms |

Backend graph and layout timings are separate from browser measurements; do not sum all rows. The browser series ran after the local benchmark had populated the snapshot's server layout cache. The original copied layout did not match this snapshot's graph; that does not establish the live app's cache hit rate.

## Priorities

1. **Move compact graph layout off the browser main thread.** `web/ui/src/lib/graphFocus.ts:compactOverview` runs D3 simulation and a second collision pass synchronously. The browser CPU trace is dominated by collision-force callbacks and quadtree traversal. `graphFocusCache.ts` saves the result in sessionStorage, explaining why same-tab reloads are much faster while a fresh tab repeats the work. Start by moving the calculation to a worker while showing existing positions; consider sharing persisted display positions if their cache key can remain correct. Preserve graph geometry and selection behavior.

2. **Reduce graph reconstruction and server blocking.** `lib/assertionGraph.ts:buildAssertionGraph` rereads immutable logs and Markdown. The backend CPU trace shows event-file reads and Markdown link matching prominently. The server also performs synchronous layout on a cache miss. Reusing projection-backed records, avoiding repeated log reads, and calculating layouts outside the request event loop are candidates. Measure freshness and invalidation carefully before introducing another cache. The graph response was about 2.66 MB.

3. **Reduce search candidate materialization.** Backend CPU samples concentrate in SQLite reads under `assertionRanked`, entity assertion retrieval, and `projectedSourceHeads`. Search is already projection-backed; inspect how many rows and bodies are materialized before bounding/ranking the visible results. The browser numbers include the existing 150 ms debounce, network/route work, and rendering. They are single observations per query class, not percentile estimates.

4. **Measure memory retention separately.** The combined backend benchmark finished around 1.60 GB RSS. This is enough to justify a dedicated retained-memory investigation, but is not evidence of a leak: it includes runtime/allocator reservations and all graph/evidence/search work in one process. Measure after GC and across repeated invalidation cycles before changing cache ownership.

Cached briefing input preparation is measurable but not the first target. Even a dense entity's cache hit stayed below 50 ms with a warm graph. A cold graph may make that path much more expensive because input preparation precedes the briefing cache lookup.

## Method and limits

- Main vault and running dev instance were left untouched. Files were copied into a marked private temporary directory; SQLite databases were copied using read-only backup connections. Copies are individually consistent, not one atomic snapshot across all files.
- Credentials, attachments, provider configuration, and raw external transcripts were excluded. No model inference was made. Two selected briefing caches initially missed; deterministic stub results seeded the subsequent cache-hit measurements. These measure cache mechanics, not generated-answer quality or natural cache hit rate.
- Production UI bundle in local headless Chrome, 1440×1000. Browser external requests and non-GET requests were blocked. Server mounted only local read routes; setup used the normal headless 404 fallback. Session, notification, integration, and watcher behavior is therefore outside this benchmark. In particular, ignore idle request counts as representative app polling measurements.
- OS filesystem caches were not flushed. Five local samples per note/query; seven alternating browser note navigations; three graph loads with CPU sampling enabled. A second CPU-trace series reproduced a 3,511 ms first-load main-thread task; one reload in that series had unexplained extra navigation delay, so no tail-latency claim is made.
- Note timing waits for title/metadata and two animation frames. It measures note presentation, not completion of all graph animation or briefing content. Search timing waits for the matching response, result overlay, and two frames.
- Raw traces, note titles, search text, and the snapshot were temporary private artifacts. The committed JSON contains only counts, timings, anonymous sample labels, and route paths.

## Harnesses

- `test/support/profileVaultScale.ts`: local graph, briefing-cache and search timings; requires a `.benchmark-snapshot` marker under a `bb-vault-scale-*` directory. Writes private selections to an explicitly supplied path.
- `test/support/vaultScaleServer.ts`: guarded snapshot server on loopback (default port 53917), local read routes only.
- `test/support/vaultScale.browser.cjs`: run with `NOTE_PROFILE_FIXTURE` pointing to the private selections and `GRAPH_PREVIEW_URL` pointing to that server; optional `PLAYWRIGHT_MODULE` locates Playwright.
- Existing `test/support/graphStartup.profile.cjs`: graph first-draw and CPU profiling against the same isolated server.

All new harnesses were exercised; targeted lint and JavaScript syntax checks passed. Full application tests were not rerun because this pass adds profiling tools and reports only.

[Aggregate measurements](2026-09-19-vault-scale.json)
