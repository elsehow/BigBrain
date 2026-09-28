# Indexed note readers and consistent snapshots

Measured 2026-09-20, following #853 and implementing #856. Baseline
`9134761` has the same production code as merged main `2b39575`;
timings use candidate `4e3793f`. Final production commit `8038115` also
restores strict identity recovery when reconciliation fails; the indexed
queries measured here are unchanged. Raw samples and hashes are in
[the JSON report](2026-09-20-note-readers.json).

## What changed

- One typed note resolver handles canonical identity and content for the API,
  viewer and briefings. Each caller still supplies its own Markdown access
  policy; API/viewer source reads retain exact-file 404 behavior, while
  briefings use validated projected evidence.
- Schema 16 stores source metadata without bodies and projects thread paths,
  aliases and ordered membership. Each source append marks membership dirty;
  reconciliation publishes the batch atomically before a shared snapshot is
  borrowed. Graphs, thread readers and provider-state listings use this same
  grouping. A provider write resolves only selected paths before any external
  call; provider operations remain serialized and validated in full first.
- Entity-link existence uses SQL existence checks, without materializing a
  dossier or its sources. Entity evidence and owner validation need only
  compact metadata.
- Voice content and settlement now share a snapshot. Identity selects its
  declaration procedure directly. Memory reads all event IDs and assertions,
  but source bodies only for voice; its checkpoint comes from those same
  arrays. Decoded views share the existing bounded revision cache, with no
  additional freshness clock.

## Measurements

Bun 1.3.9 on macOS 26.6.2 arm64, synthetic scratch vaults only. Each fixture
contains 1,200 large email sources in 300 threads, one owner declaration,
three voice arrivals, 1,201 assertions and one decline. Email bodies total
39,627,690 bytes. A thread has four messages and 132,084 body bytes.

Two separate processes per operation/side, reversing before/after order in
the second trial. Each process measures the first read and five further
reads. The table shows the median of the two first reads and of the two
warm medians, in milliseconds. “First” means an empty process-level read
cache over an already prepared projection; it is not a cold filesystem or
an end-to-end startup measurement. No providers or models are called.

| Operation | First before | First after | Warm before | Warm after |
| --- | ---: | ---: | ---: | ---: |
| Thread view (4 messages) | 83.60 | 6.94 | 0.45 | 0.58 |
| Thread note payload | 108.42 | 7.80 | 25.50 | 1.03 |
| Provider-state listing (no provider calls) | 82.93 | 23.61 | 2.44 | 0.69 |
| Voice messages (2 matches) | 43.30 | 6.93 | 42.48 | 0.39 |
| Owner declaration (1 match) | 70.05 | 6.51 | 54.01 | 0.40 |
| Memory inputs (3 voice messages) | 70.38 | 23.23 | 58.96 | 0.77 |

All six operations produced matching canonical JSON hashes in both trials.
For memory, the comparison covers the metadata actually used by the prompt,
every voice body, live assertions, supersession and complete checkpoints;
it intentionally excludes the removed, unused non-voice bodies.

A separate instrumented first read counts source bodies returned by
`JSON.parse`; instrumentation is excluded from latency samples. Repeated
parsing counts repeatedly, exposing the old thread-note entity lookup's
extra corpus load. These are decoded input bytes, not disk I/O or RSS.

| Operation | Bodies decoded before → after | Body bytes before → after |
| --- | ---: | ---: |
| Thread view (4 messages) | 1204 → 4 | 39,627,798 → 132,084 |
| Thread note payload | 2405 → 4 | 79,255,518 → 132,084 |
| Provider-state listing (no provider calls) | 1204 → 0 | 39,627,798 → 0 |
| Voice messages (2 matches) | 1204 → 2 | 39,627,798 → 52 |
| Owner declaration (1 match) | 1204 → 0 | 39,627,798 → 0 |
| Memory inputs (3 voice messages) | 1204 → 3 | 39,627,798 → 78 |

## Costs and limits

- Median initial projection preparation across the 12 runs per side rose
  from **875.4 ms to 901.3 ms** (about 3%). Thread grouping moves into the
  projection transaction. A dirty source batch still regroups all compact
  source metadata; this is not incremental union-find maintenance.
- Projection file size rose from **134,963,200 to 136,196,096 bytes** (0.91%).
  An existing installation rebuilds this disposable projection once for
  schema 16. Event logs and vault contents are unchanged.
- Warm thread-view reads rose from **0.45 to 0.58 ms**: the old reader could
  reuse retained full source objects. It now queries just the selected thread.
- Production diff: **384 lines added, 158 deleted, net +226**. This is a
  reduction in duplicated decisions and unnecessary data loading, not a
  line-count reduction. New projection tables and query code account for
  much of the addition.
- Raw process-memory observations are included for inspection but are noisy
  under Bun's GC and allocator. They do not establish an RSS or retained-heap
  improvement. Decoded-body reductions above are the reproducible measure.
- Freshness follows the existing shared snapshot policy: local change hints
  trigger reconciliation; a one-second census recovers missed external
  changes. On projection failure, voice retains its pending-only raw-log
  fallback and memory retains its tolerant raw-log fallback. These degraded
  paths retain their historical filesystem consistency; they do not promise
  a transactional snapshot. Identity uses strict raw-log recovery, reading source evidence only if an
  assertion claims the declaration procedure.

## Validation

Each implementation step was tested before committing. Final full suite:
**1,980 passed, 3 skipped, 0 failed** across 219 files. Engine typecheck and
lint pass. Viewer checks report zero errors/warnings and its production
build passes (existing chunk-size advisory remains).

New coverage exercises canonical identity/access policy, exact-file versus
projected-source behavior, thread membership across append/rebuild/retraction,
metadata-only provider targets, concurrent voice settlement, identity and
memory checkpoints during publication, backdated arrivals and degraded
recovery. Existing tests cover aliases, supersession, original citations,
provider validation/serialization and memory prompt rendering.

To reproduce with two installed engine checkouts:

```sh
bun test/support/profileNoteReaders.ts /path/to/baseline thread /tmp/before.json
bun test/support/profileNoteReaders.ts . thread /tmp/after.json
# Operations: thread, note, readState, voice, identity, memory.
# Append “decode” for a separate first-read decoding measurement.
```
