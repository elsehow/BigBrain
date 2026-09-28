# Search decoration — 2026-09-20

Issue #841, following the gardener baseline. Search needed the complete graph for
navigation importance, but decorated source/thread results before asking for it.
A cold request therefore loaded the assertion/source logs twice. Decoration also
reparsed each matching source's content even though the graph had retained the
same validated events.

Build the required graph first and reuse its shared source/thread snapshot. Keep
ranking, thread coalescing, timestamps, filers and pagination unchanged. There is
no additional cache or freshness policy.

## Measurements

Two sequential baseline/optimized pairs on the same marked disposable real-vault
snapshot (3,850 graph nodes), running the actual search route. Each process makes
three explicitly invalidated searches, eight warm searches across fixed queries,
and a search after the real filesystem watcher's default refresh/layout path.
The watcher detects a synthetic memory note; its search must return one hit.
The synthetic note is removed afterward. No model runs or live-vault writes.

| Phase | Samples per version | Before median | After median |
| --- | ---: | ---: | ---: |
| Invalidated search | 6 | 1261.18 ms | 790.53 ms |
| Warm search | 16 | 100.15 ms | 50.26 ms |
| Search after watcher refresh | 2 | 94.87 ms | 73.29 ms |

All 12 existing-content response payloads matched byte-for-byte in each pair.
The synthetic-note result differs in its creation timestamp. Tests also cover
thread coalescing and pagination after a new message through live invalidation.

This is a small sequential sample, not a population percentile or an isolated
CPU comparison. Filesystem/JIT/layout warming and machine load affect the first
request: observed maxima were 2862.19 ms before and 2422.31 ms after. The optimized
path still synchronously builds the graph. Default watcher refresh/ping took
about 1.07 seconds with a warm layout in both versions; initial baseline layout
work took 4.55 seconds. Do not attribute that layout warmup difference to this fix.

Graph rebuild and watcher stalls are separately tracked in
[#845](https://github.com/elsehow/BigBrain/issues/845). This fix reduces duplicate
work but does not eliminate every multi-second cold-start pause.

## Reproduction

Run in a worktree with installed dependencies, against a marked profiling snapshot:

```
bun test/support/profileSearchDecoration.ts <engine-checkout> <snapshot> <output-json>
```

Use the same snapshot for baseline and candidate, in fresh processes. The harness
requires its synthetic probe to be absent, uses the real watcher and cleans it up.
Only timing/count aggregates and response digests are output; content is not saved.
