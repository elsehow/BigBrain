# Application history read budgets

Measured with fabricated records using `bun test/support/applicationHistoryBenchmark.ts`
on macOS, Bun 1.3.9. Baseline: `1628dabd`; implementation: #1016.
The baseline used the same generator, with read counters added to the old
receipt reader and `loadSessionRecords`. No real vault data was accessed.
Times are representative local observations, not CI thresholds; filesystem cache,
other processes and allocator behavior vary. Receipt warm times average five calls.
Archive warm startup means a new owner with an existing index.

| Operation | Records | Cold ms, before → after | Warm ms, before → after | Warm full files, before → after | Warm decoded bytes, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| receipts | 200 | 7.03 → 12.15 | 4.46 → 1.56 | 200 → 20 | 979490 → 97949 |
| receipts | 2000 | 45.31 → 65.02 | 44.7 → 10.25 | 2000 → 30 | 9796890 → 146970 |
| receipts | 10000 | 329.54 → 451.89 | 268.09 → 64.26 | 10000 → 30 | 48988890 → 146970 |
| pilot | 200 | 12.52 → 13.62 | 8.43 → 2.2 | 200 → 0 | 1163200 → 0 |
| worker | 200 | 7.7 → 12.54 | 6.14 → 2.55 | 200 → 0 | 1103600 → 0 |
| pilot | 2000 | 82.12 → 91.54 | 67.99 → 15.76 | 2000 → 0 | 11632000 → 0 |
| worker | 2000 | 52.31 → 87.7 | 46.21 → 18.29 | 2000 → 0 | 11036000 → 0 |
| pilot | 10000 | 402.87 → 716.54 | 340.02 → 85.64 | 10000 → 0 | 58160000 → 0 |
| worker | 10000 | 296.69 → 509.9 | 246.45 → 99.98 | 10000 → 0 | 55180000 → 0 |

At 10,000 records, cold receipt rebuilding decodes 10,030 files / 49,135,860
bytes (all records plus the selected page). Cold Pilot and worker indexing decodes
10,000 records each, 58,160,000 and 55,180,000 bytes respectively. Rebuilds
are intentionally more expensive than the previous eager scan. Warm calls still
perform an O(N) directory/stat census to notice externally edited or deleted
records; this is bounded decoding, not constant-time filesystem work.

Retained archive payload, measured as serialized owner map contents at 10,000
records, falls from 58,170,001 to 5,950,003 bytes for Pilots and from 55,190,001
to 4,490,003 bytes for workers. This reproducible payload measure is not RSS.
The script also reports post-GC `bun:jsc` heap deltas; interning and collection
of earlier runs can produce zero/negative deltas, so those are diagnostic only.
Selected detail reads one record: 5,816 bytes for Pilot, 5,518 for worker;
the old reader read zero at selection because it retained every transcript.

## Budgets and semantics

- Unchanged warm latest-N receipt queries decode at most N authoritative records
  (default 30, maximum 200), independent of other actors' result bodies.
- Warm startup/list of settled archives decodes zero transcripts; opening one
  archive reads one. Summaries retain no transcript bodies. Active recovery is
  deliberately eager: pending inputs, drafts, unfinished ingestion, native state,
  and working turns do not qualify for lazy loading.
- Reference 10,000-record warm queries/startup should remain around 100 ms on
  this machine. CI enforces deterministic file-read budgets rather than timings.
- Search intentionally reads historical transcript text without retaining every
  transcript; selecting matching detail remains independent.
- Receipt order is creation descending, filename ascending for ties. Cursors
  are actor/vault scoped; inserts before a cursor do not duplicate prior pages.
  Pilot legacy receipts follow modern pages, ordered by request key, excluding
  identities already owned by modern files (even damaged files). Results are
  inspected, never replayed or imported by pagination.
- `.state/application-history` is derived and disposable. Changed/deleted files
  invalidate metadata; damaged records remain visible as aggregate issues.
  Deleting or corrupting the database rebuilds it from durable JSON. Neither
  rebuild nor list authorizes effects. Exact execution still validates the
  authoritative receipt and blocks uncertain or unreadable outcomes.

Regressions in `test/applicationHistory.test.ts` cover page boundaries,
concurrent insertion, actor/vault cursor isolation, cold/warm reads, cache loss,
malformed authoritative records, selected detail, search, draft/turn recovery,
legacy worker detail, and nonduplicated legacy action pages. Existing lifecycle,
queue, alias, output and migration tests remain merge gates.
