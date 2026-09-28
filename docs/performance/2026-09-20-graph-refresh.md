# Graph rebuild responsiveness — 2026-09-20

Issue #845. Graph construction rereads and validates the event logs, reconstructs
threads and explicit links, and derives navigation importance. Layout then runs a
force simulation. Both previously ran synchronously on the viewer server, including
inside its filesystem watcher. Moving the work between requests did not make it
nonblocking: timers and unrelated HTTP requests still waited for it.

## Change

Search, graph requests, Quick briefing preparation and watcher graph warming now
await short-lived background workers running the same graph/layout builders. The
graph worker transfers its validated source/thread record alongside the graph and
connection evidence, preserving shared reads rather than replaying logs again on
the request thread. Bun's small-heap mode limits the worker's memory appetite.
Workers terminate after each job; no idle worker or duplicate resident vault is kept.

Concurrent readers share a graph build. There is at most one graph build and one
layout computation per vault. Watcher invalidation occurs immediately on a relevant
change; a generation check and the existing database/WAL stamp reject obsolete
results. Layout requests recheck freshness after settling, skip superseded queued
layouts, and cannot overwrite the current layout with an older result. Pings wait
for preparation, and an obsolete or stopped watcher cannot send a late ping.

The synchronous builders remain available to existing synchronous consumers,
including command-line and Pilot context helpers. SQLite search, projection sync,
and response decoration still run synchronously. This change addresses graph and
layout pauses; it does not claim every server operation is now nonblocking.

## Measurements

One finalized baseline/candidate pair, preceded by exploratory repetitions, on the
same marked disposable real-vault snapshot: 3,846 nodes and 8,138 edges. No model
calls or live-vault writes. Three explicitly invalidated graph builds, one cold
layout, and one actual filesystem-watcher change that adds a linked synthetic
memory note and forces a new layout. The harness restores the original layout and
removes the note afterward.

A separate client thread repeatedly sends HTTP requests to the measured server
loop. A client scheduled on that same loop would miss requests during its stall;
the independent client and 10 ms server timer measure that delay directly.

| Phase | Baseline wall time | Worker wall time | Baseline maximum timer delay | Worker maximum timer delay | Baseline maximum HTTP delay | Worker maximum HTTP delay |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph builds (3; ranges) | 642–1,772 ms | 878–903 ms | 632–1,762 ms | 23–27 ms | 643–1,786 ms | 21–25 ms |
| Cold layout | 3,560 ms | 3,726 ms | 3,550 ms | 2 ms | 3,561 ms | 1 ms |
| Watcher + changed layout | 4,246 ms | 5,094 ms | 3,927 ms | 22 ms | 3,928 ms | 28 ms |

This improves responsiveness, not total rebuild throughput. Worker startup, an
independent JS heap/JIT, and snapshot transfer add overhead. The changed-layout
refresh took about 0.85 seconds longer but no longer froze the server for nearly
four seconds. The UI still waits for a fresh, settled graph rather than receiving
stale rankings or intermediate positions.

Graph payload digests matched across all three builds in both versions. The
search-route comparison also matched all 12 existing-content payloads exactly;
the synthetic new note has a different creation timestamp by design. Regression
tests cover evidence/source sharing, errors and retry, projected filing changes
before watcher notification, mid-build invalidation, layout freshness, and watcher
shutdown/overlapping changes.

## Memory tradeoff

Twelve successive graph rebuilds in fresh processes, collecting after each and
sampling macOS `phys_footprint` through the existing native profiler definitions:
last six samples were 269–294 MiB baseline and 270–283 MiB with small-heap workers.
Retained JS heap remained roughly 158–160 MiB in both. The initial post-build
physical footprint was higher: 718 MiB baseline versus 1,050 MiB candidate. That is
a sample, not an instrumented peak; building and transferring a snapshot requires
temporary additional memory. RSS includes allocator residency and stayed higher
than physical footprint, so it should not be interpreted as retained JS objects.
A one-second idle sample used about 12 ms of CPU baseline and 18 ms candidate;
these short samples do not establish a long-session idle/resource regression test.

These are small sequential measurements on one machine, affected by filesystem,
JIT, GC and system load. They are not population percentiles. No raw source content
or private identifiers are included in the report.

## Reproduction

From a checkout containing the harness, run baseline and candidate sequentially:

```
bun test/support/profileGraphRefresh.ts <engine-checkout> <marked-snapshot> <aggregate-output.json>
bun test/support/profileSearchDecoration.ts <engine-checkout> <marked-snapshot> <aggregate-output.json>
```

The snapshot must be a disposable `bb-gardener-profile-*` or `bb-vault-scale-*`
directory with `.benchmark-snapshot`. External database overrides are refused.
The harness does not invoke gardening or other model routes.
