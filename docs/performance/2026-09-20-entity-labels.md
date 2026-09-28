# Batch label validation (#758)

The intake guard now aggregates distinct live claim counts by canonical
entity in SQLite, returning entity counts instead of every assertion/entity
link. Each `submitWire` call lazily prepares one inventory of labels, word
rarity, and normalized candidates for its entire validation phase. All links
are validated before any items are appended, as before. The next submission
gets a fresh inventory; explicit existing links need no inventory at all.

Synthetic scratch fixture on macOS arm64, Bun 1.3.9: 10,000 assertions,
20,000 entity links, 500 entity labels. Before is 83925bd. Five measurements
of 40 independent text validations, with new numeric labels so outcomes are
deterministic and cannot match one another. No model calls or real vault
reads/writes. This isolates link validation, excluding log writes, commits,
and projection synchronization; it is not a gardener end-to-end speedup.
Forty follows the issue's workload; today's wire limit is 32, covered by a
separate submission-path regression test.

| Measurement | Before | After |
|---|---:|---:|
| 40-text validation median | 1,111 ms | 31.7 ms |
| Range across five samples | 452–1,118 ms | 30.7–35.2 ms |
| One label inventory query | 11.5 ms | 13.5 ms |

The gain is principally amortizing preparation across the batch, not making
one SQLite query faster. Aggregation also avoids materializing 20,000 link
rows into JavaScript each time. Every validation-output hash matches.
Raw measurements are in the adjacent JSON; the spread in the baseline is
retained rather than presented as a stable latency guarantee.

Unicode changes are separate correctness improvements: CJK labels no longer
normalize to empty strings; common non-decomposing Latin letters fold;
non-Latin marks survive; character counts/edit distance use code points.
Entity IDs and stored labels are unchanged. Existing lookalike rules still
ask for confirmation rather than automatically merging entities, with the
same `new:` escape hatch. This does not introduce cross-script transliteration.

Tests cover canonical and alias counts, distinct counting when a claim links
both, revoked-only entities, canonicals known only through aliases, Unicode
refusals, rarity/order, and lazy single preparation with next-batch freshness.

```sh
bun test/support/profileEntityLabels.ts /path/to/engine /tmp/labels.json
```
