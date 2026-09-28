# Backend graph reconstruction — 2026-09-20

Warm reconstruction fell from **2,252 ms to 969 ms**, a **57% reduction**, on the same private snapshot. The full graph and ordered briefing evidence remained identical.

| Stage | First run | Median of next five |
| --- | ---: | ---: |
| Before | 2,370 ms | 2,252 ms |
| Markdown scanning/masking changes | 1,307 ms | 1,140 ms |
| Plus shared reads within each build | 1,098 ms | 969 ms |

The snapshot contained 11,781 log files and 1,208 Markdown files. Every measured run produced the same 4,166 nodes, 12,008 edges, and 73,253 ordered evidence connections. SHA-256 digests of the complete graph JSON and ordered evidence records matched across all 18 runs, covering node metadata, weights, ordering, memory support, identity, pending status, and evidence text—not just the layout hash.

## Changes

- Replaced the inline Markdown label regex with a single pass over brackets. Destination parsing remains anchored at the closing label bracket. This preserves image exclusion, malformed/nested bracket behavior, and evidence offsets while avoiding expensive repeated label matching across large transcripts.
- Skip line splitting when a document contains no possible code-fence delimiter. Within graph construction, mask fences once and share that text between explicit-link and assertion-citation extraction. Inline-code masking remains specific to explicit links, preserving existing citation behavior.
- Read the complete assertion log and revocations once per build. Use that same snapshot to select live assertions and determine pending arrivals. Revoked-only citations still settle work unless a decline supersedes that settlement; they are not silently dropped from this calculation.
- Reuse the alias resolution already loaded into the graph/note record snapshot.

No additional long-lived cache or database migration was introduced. Existing invalidation behavior remains. The earlier source-header index migration still happens automatically through the projection's schema-version check; existing users pay that rebuild once, while new vaults start with the current schema.

## Validation and limits

- Full regression suite: **1,993 passed, 3 opt-in tests skipped, 0 failures**. TypeScript, targeted lint, and diff checks passed.
- Added comparison against the prior inline-link matcher for 506 fixed and seeded malformed/nested inputs, plus fence, inline-code, reference-link, and evidence-offset checks.
- Existing graph/feed tests cover pending arrivals, declines, aliases, and source identity. Snapshot equivalence additionally compares every observed evidence connection.
- Six runs per stage in separate processes; medians exclude the first run. OS filesystem caches were not flushed. Timings include digesting evidence in the observer, and exclude force-layout simulation, HTTP delivery, and browser rendering. This is not a claim that total app startup is under one second.
- Graph reconstruction still reads the log and Markdown corpus synchronously. Approximately one second remains here; layout-cache misses are a separate cost. Further work should measure those reads before changing cache ownership or moving reconstruction off the request thread.
- The private snapshot excluded credentials, provider configuration, and attachments. No model calls were made; the installed app and live vault were untouched. The snapshot and intermediate measurements were deleted after retaining aggregate results.

Run `bun test/support/profileGraphBuild.ts <snapshot-root>` to reproduce against a disposable directory named `bb-graph-profile-*` containing a `.benchmark-snapshot` marker. The harness emits only timings, counts, memory totals, and content digests.

[Aggregate measurements](2026-09-20-graph-rebuild.json)
