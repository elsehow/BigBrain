# Narrow feed snapshots and shared freshness — 2026-09-20

Follow-up to [compact graph/feed inputs](2026-09-20-compact-readers.md),
[#862](https://github.com/elsehow/BigBrain/issues/862), and
[#863](https://github.com/elsehow/BigBrain/issues/863).

Feed rebuilds now borrow source summaries, thread membership, and settlement
facts from the existing revision owner. They no longer decode assertion prose,
Markdown headers, or link evidence. Graph construction reuses those same source
objects when it needs the rest of the corpus.

Graph readers now use the read model's one-second reconciliation gate instead
of a separate 60-second memo lifetime. The async reader performs a due census in
a worker, shares that job among concurrent callers, and keeps the existing graph
if its revision is unchanged. There is no new idle polling timer.

## Method

Baseline: `7525d53` (the compact-input refactor). Candidate: `4da2e7f`.
Bun 1.3.9, Darwin arm64; two separate-process trials per side and operation,
run sequentially against fresh synthetic scratch vaults. No real vault,
provider request, or model call is involved.

[`profileCompactReaders.ts`](../../test/support/profileCompactReaders.ts)
uses the preceding report's fixture: 1,200 sources (800 emails forming 200
threads, 200 clips, 200 transcripts), 1,200 assertions, 120 entities, 60 Markdown
notes, and 39,276,990 bytes of source bodies. Projection preparation is separate
from the first read. Five warm reads follow, then an append and six more reads.
The `shared` operation prepares a feed page and then builds the graph/evidence,
matching the worker's order without including worker startup or transfer.
Decode instrumentation runs separately from timing trials.

[`profileReadFreshness.ts`](../../test/support/profileReadFreshness.ts) uses
1,200 short sources without assertions or Markdown. It reads a graph, measures
200 warm memo hits, then writes an external arrival directly to disk without
notifying the engine. It advances the reconciliation clock by 1,100 ms and
reads again; if still stale, it advances by another 60 seconds. A later read
after a further 61 seconds checks unchanged-revision behavior. Only `Date.now`
in the caller is controlled; elapsed timings and worker clocks remain real.
A one-millisecond interval observes event-loop progress during the async work.

Canonical SHA-256 digests compare the complete graph and ordered connection
evidence, the feed page, and the full feed before and after the append. All
baseline/candidate digests match. The freshness fixture compares initial,
eventually discovered, and unchanged graph/evidence results across both versions.

Raw samples, digests, decode counts, and preparation/storage observations:
[JSON](2026-09-20-feed-freshness.json).

```sh
bun test/support/profileCompactReaders.ts /path/to/baseline feed /tmp/before.json
bun test/support/profileCompactReaders.ts . feed /tmp/after.json
# Repeat for graph and shared; add a final decode argument for parse accounting.
bun test/support/profileReadFreshness.ts /path/to/baseline async /tmp/before-fresh.json
bun test/support/profileReadFreshness.ts . async /tmp/after-fresh.json
# Repeat with sync.
```

## Feed and shared construction

The clear improvement is the amount of data decoded, not end-to-end latency:

| Initial feed rebuild | Before | After |
| --- | ---: | ---: |
| JSON bytes parsed | 1,446,540 | 447,040 |
| JSON parse calls | 5,200 | 1,420 |
| Assertion events decoded | 1,200 | 0 |
| Markdown headers decoded | 60 | 0 |
| Nonempty link arrays decoded | 1,260 | 0 |
| Source bodies decoded | 0 | 0 |

That is **69.1% fewer JSON bytes** and **72.7% fewer parse calls**. After an
append, total parsing falls from 1,848,240 to 848,736 bytes; both versions also
parse the new source's 56-byte body once during projection catch-up. Existing
source bodies stay out of the reader. Combined feed/graph preparation parses
exactly the same bytes and events as before: splitting the view adds no duplicate
source decoding. A regression test also checks object identity across both views.

Timing values below are means of the two first-read measurements or warm medians:

| Operation | Before | After |
| --- | ---: | ---: |
| First feed page / publication | 39.75 ms | 38.59 ms |
| Feed after append, including reconciliation | 55.70 ms | 55.20 ms |
| Warm feed page | 0.204 ms | 0.213 ms |
| First graph construction | 45.68 ms | 46.48 ms |
| Graph after append, including reconciliation | 67.84 ms | 64.64 ms |
| Warm graph construction | 20.64 ms | 20.23 ms |
| First combined feed/graph preparation | 62.58 ms | 63.18 ms |
| Combined preparation after append | 72.92 ms | 74.84 ms |

These small differences across two trials do not establish a material latency
improvement or regression. The graph measurements here deliberately run the
builder rather than its outer memo. This change introduces no projection schema,
table, or column. Main database file sizes match baseline/candidate within each
operation; that observation excludes the transient WAL. GC/process-memory samples
are retained in the raw data, but no process-RSS improvement is claimed.

## Freshness and its cost

With no watcher, feed, or search traffic, both baseline graph readers remain
stale at the 1,100 ms read. Both candidate readers see the new arrival then.
The baseline discovers it at the fixture's next scheduled read, 61,100 ms after
the write. This demonstrates the policy change from 60 seconds to one second;
it is not a claim of a background refresh exactly one second after every write.

| Graph reader measurement | Before | After |
| --- | ---: | ---: |
| Sync warm-hit median | 0.128 ms | 0.131 ms |
| Async warm-hit median | 0.275 ms | 0.314 ms |
| Sync unchanged periodic check | 6.48 ms | 3.19 ms |
| Async unchanged periodic check | 48.16 ms | 31.34 ms |
| Same graph object after unchanged check | No | Yes |

These values average the two trials' medians or periodic-check times. Async
candidate warm medians were 0.351 and 0.277 ms, so the observed 0.039 ms mean
increase should not be treated as a stable overhead estimate. Sync warm-hit
overhead was about 0.003 ms. Neither hot path runs a full census on each request.

The candidate's changed-revision read costs 14.41 ms synchronously or 54.63 ms
asynchronously, including reconciliation and graph preparation. The async
event-loop interval fired 45 and 48 times during those two reads. Unchanged async
checks avoid graph construction and transfer but still pay worker startup and
the census. Under continuous graph traffic, that cost can now occur about once
a second instead of once a minute. Other readers share the gate, and an idle
application does not start periodic workers for this fallback.

## Correctness and maintenance

- Source settlement remains consistent across citations, revocations, declines,
  and mixed live/revoked citations. Tests exercise absent and partially rebuilt
  projections, plus the persisted paginated feed.
- Feed-only reads decode none of the graph-only prose or evidence. Nested feed
  and graph readers retain the borrowed SQLite revision during a concurrent
  publication; persisted feed pages retain their stale-publication guard.
- Sync and async graph-only tests cover unannounced arrivals, Markdown/title/link
  edits, and removals at the shared fallback boundary.
- An async reader called inside a borrowed snapshot resolves from that snapshot
  before yielding. A stale worker cannot publish a graph or consume a newer
  invalidation hint. Existing worker-deduplication, failure, and layout tests pass.
- The graph's separate TTL and timestamp/change fields are removed. Narrow and
  full records remain views owned by the same per-revision cache.

Validation was incremental: focused feed/settlement/snapshot checks after the
first change, then 57 targeted tests for shared freshness and graph workers.
The final suite passed **1,996 tests**, with **3 opt-in native tests skipped**,
and no failures across 223 files. Type checking, lint, generated-plugin checks,
Svelte checking, and the production viewer build passed. The viewer retains
its existing large-chunk build advisory.
