# Shared vault read model

Implemented on `refactor/vault-read-model`, against baseline
`20c56929a5c0b4eec50b98397363793c53ca7fab`. Production checkpoint: `422689d`.

## What changed

Feed, entity notes, graph construction and search previously owned separate
reads or caches of the same record. Their refresh rules differed; graph workers
also transferred a decoded assertion/source corpus back to the server.

`lib/vaultReadModel.ts` now owns synchronous read transactions and the decoded
corpus. Nested readers borrow the same transaction. Indexed entity/source reads
load the relevant rows; feed pages read compact, ordered SQLite rows; graph
construction uses a shared revision and links parsed when documents change.
Search and briefing evidence use these same snapshots.

```mermaid
flowchart TD
  logs[Immutable event logs] --> sync[Transactional reconciliation]
  md[Mutable Markdown] --> sync
  sync --> db[SQLite generation + revision]
  db --> indexed[Indexed feed, entity and source reads]
  db --> search[Search and memory]
  db --> graph[Graph worker and briefing evidence]
```

The logs remain authoritative. Schema 15 rebuilds disposable SQLite state;
it does not migrate vault files. A rebuild replaces tables in one transaction
on the same database inode. Existing WAL readers retain their complete old
snapshot, and a failed catch-up or rebuild preserves the published generation.
Derived feed publication checks its input revision before writing. Graph workers
prepare the feed too and return graph/evidence without a second decoded corpus.

Local append hints and watcher invalidation trigger reconciliation immediately.
Without hints, ordinary reads reconcile on a one-second interval; the graph
has a 60-second fallback when notifications are missed. Search checks mutable
Markdown metadata on each scan, preserving immediate memory-edit visibility.
Incremental reconciliation never reparses already-projected event files. A manually retracted source is hidden
from openable views while its already-validated assertion evidence remains in
SQLite. This preserves the existing search contract; deleting cited evidence
still makes a fresh strict replay invalid.

Two modules disappear: `recentCache.ts` and `watchedVaultCache.ts`. Production
changes are **525 inserted / 402 deleted lines, net +123**. The simplification is
fewer owners and refresh rules, not a smaller total line count. The new code
includes atomic publication and recovery behavior the separate caches lacked.

## Measurements

[Raw trials and output hashes](2026-09-20-vault-read-model.json).
macOS 26.6.2 arm64, Bun 1.3.9. Two alternating baseline/candidate trials, each
in a fresh process and scratch vault: 1,200 sources, 3,600 assertions, 120
entities, 60 Markdown notes, 40 explicit links per source. No personal data,
provider calls or live vault writes.

Each operation has six samples. “First” is the median of the two first samples;
“warm” is the median of ten subsequent samples. Operations run in harness order:
projection, viewer feed, Pilot feed, entity, search, graph, append, changed feed,
changed graph. These are application timings with warm OS file caches, not
isolated cold-process timings for every operation. The candidate entity read,
for example, follows feed preparation, though it uses its own indexed query.

| Operation | Before | After | Result |
| --- | ---: | ---: | --- |
| Initial projection | 1,146 ms | 439 ms | 2.6× faster |
| First viewer feed page | 146.3 ms | 45.3 ms | 3.2× faster |
| Warm Pilot feed page | 110.8 ms | 0.20 ms | About 550× faster |
| First entity note | 106.8 ms | 1.82 ms | About 59× faster |
| Warm graph reconstruction, including ordered evidence | 194.8 ms | 55.4 ms | 3.5× faster |
| Viewer feed after an append | 109.0 ms | 46.2 ms | 2.4× faster |
| First search | 32.7 ms | 25.0 ms | 23% faster |

The baseline viewer already cached its complete feed. Its warm reads were
under 0.01 ms, versus 0.20 ms for the shared SQLite page. The large warm-feed
gain belongs to **Pilot**, whose old path repeatedly rebuilt the feed. Likewise,
the graph timing measures reconstruction, not a hit in the existing graph memo.

All compared feed, entity, search, graph and ordered-evidence outputs have
identical SHA-256 digests, both before and after the appended source.

There are measured costs: warm entity reads rose from 0.60 to 1.21 ms, and warm
search from 7.27 to 8.59 ms. The database grew from 17.85 to 22.68 MiB because it
now stores feed rows, Markdown and parsed link spans. End-of-run RSS was about
471 versus 509 MiB; heap readings were variable. This is **not** a demonstrated
memory reduction. These synthetic, link-heavy trials are evidence about these
paths, not a production latency guarantee.

Reproduce with the current harness and an installed baseline checkout:

```sh
bun test/support/profileReadModel.ts /path/to/baseline /tmp/baseline.json
bun test/support/profileReadModel.ts . /tmp/candidate.json
```

The harness creates and deletes its own vault and pins its database to that
scratch directory. It selects the baseline viewer cache when present, so both
viewer and Pilot paths are measured honestly.

## Validation

Each implementation checkpoint passed focused tests and engine type checking.
Final suite after integrating main `646529b`: **1,972 passed, 3 skipped,
0 failed** across 217 files. The skipped
tests require installed provider/runtime facilities. Engine type checking and
lint pass; viewer checking reports zero errors/warnings; the production viewer
build succeeds with its existing bundle-size advisory.

Added coverage checks failed catch-up, failed rebuild, schema-upgrade rollback,
readers held across successful publication, nested snapshot consistency,
stale feed publication, Markdown edits/deletions, source retraction/restoration,
and reuse of validated immutable events. Existing graph, search, threading,
supersession, alias, briefing, watcher and background-worker tests also pass.
