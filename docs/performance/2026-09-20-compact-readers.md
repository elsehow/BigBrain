# Compact graph/feed inputs — 2026-09-20

Follow-up to [the shared note-reader refactor](2026-09-20-note-readers.md) and
[#858](https://github.com/elsehow/BigBrain/issues/858).

The shared read model now decodes source metadata, projected excerpts and intake
priorities instead of every source body. Explicit Markdown links store their
evidence snippets when content is projected; graph construction resolves those
links against current identities without retaining the original bodies.
Full-text search and selected note reads retain full content.

## Method

Baseline: `e207b5b`, production-equivalent to merged base `6cc1ada`.
Candidate: `5ae8863`, the compact-input checkpoint (the profiled pre-rebase
commit was `5407b39`; its production code is identical). Both run with Bun 1.3.9 on
the same Darwin arm64 machine. Two separate-process trials per side and
operation, run sequentially, each build a fresh scratch vault:

- 1,200 sources: 800 emails forming 200 threads, 200 clips, 200 transcripts.
- 1,200 assertions over 120 entities, plus 60 memory Markdown notes.
- 39,276,990 bytes of source bodies, with three explicit links per source,
  Unicode text, and a fenced link example that must be ignored.

Projection preparation is timed separately. The first read starts after that
preparation, followed by five warm reads. Then one uncited source is appended
and another six reads measure revision catch-up and subsequent reuse. This is
a reader benchmark, not total application startup or graph-layout timing.

JSON decoding instrumentation runs separately from timing trials. Canonical
SHA-256 digests cover the complete graph and ordered observer evidence, the
feed page, and the full feed. Every baseline/candidate digest matches, before
and after the append. These fixtures keep their intended titles; the separately
tested Markdown-title bug fix intentionally changes malformed/ambiguous titles.

Harness: [`profileCompactReaders.ts`](../../test/support/profileCompactReaders.ts).
Raw samples, digests, preparation/storage measurements and process memory
observations: [JSON](2026-09-20-compact-readers.json).

```sh
bun test/support/profileCompactReaders.ts /path/to/baseline graph /tmp/before.json
bun test/support/profileCompactReaders.ts . graph /tmp/after.json
# Repeat with feed. Add a final `decode` argument for separate parse accounting.
```

No real vault, provider request, or model call is involved.

## Results

Values are the mean of the two trials' first reads or warm medians.

| Operation | Before | After | Change |
| --- | ---: | ---: | ---: |
| First graph read | 136.7 ms | 47.5 ms | 65.2% less time |
| Graph after append, including reconciliation | 152.1 ms | 64.5 ms | 57.6% less time |
| Warm graph construction | 24.9 ms | 19.9 ms | 19.9% less time |
| First feed page / publication | 131.9 ms | 41.2 ms | 68.8% less time |
| Feed after append, including reconciliation | 154.0 ms | 56.3 ms | 63.4% less time |
| Warm feed page | 0.202 ms | 0.251 ms | 0.049 ms more time |

The warm graph measurement deliberately runs the builder, not the outer graph
memo. Warm feed pages already read compact indexed rows, so this change does
not target that path. Its measured difference is small in absolute terms; two
trials are insufficient to distinguish a sustained regression from noise.

| First-read JSON decoding | Before | After |
| --- | ---: | ---: |
| Source bodies, graph or feed | 1,200 / 39,276,990 bytes | 0 / 0 bytes |
| All JSON, graph | 40,559,880 bytes | 1,434,440 bytes |
| All JSON, feed | 40,571,980 bytes | 1,446,540 bytes |

After the append, the candidate parses the new source's 56-byte body once for
projection catch-up, and decodes no existing source bodies. Baseline readers
decode the whole corpus again. Total JSON decoding on the initial read falls
about 96.4%; the number of parse calls is unchanged.

The database grows by 692,224 bytes (about 0.5%) in both operations. Graph-only
runs use 138,641,408 → 139,333,632 bytes; feed runs additionally persist feed
rows, using 139,051,008 → 139,743,232 bytes. Projection preparation remains
around 1.15–1.17 seconds across trial means. No preparation-speed improvement
is claimed. Snippet storage depends on link density and can duplicate nearby
context, so this storage ratio is specific to the fixture.

Process memory snapshots are retained in the raw data, but allocator behavior
and GC make them noisy. The supported memory-related claim is eliminated
corpus-body decoding, not a measured percentage reduction in process RSS.

## Correctness and maintenance

- Shared note-window validation closes the HTTP/MCP bounds/order mismatch.
  Transport-specific flag decoding, formatting, and access remain separate.
- Graph, reader, and briefing Markdown titles now use one interpretation;
  a body line beginning `title:` no longer overrides the real heading.
- Projection schema 17 rebuilds compact summaries and link evidence from the
  existing files, including corrected titles; it never edits event logs.
- The read model no longer imports the voice/identity facades. Their pure
  vocabulary and recognition rules are shared through lower-level modules.
  A transitive runtime-dependency test guards both removed cycles.

Validation was incremental: 143 targeted tests for reader contracts and
metadata, 78 for compact inputs and graph/feed/note behavior, then 110 for
policy extraction and its dependency guard. After rebasing onto `8e9c79e` (seven additional main-branch tests), the final suite
passed **1,991 tests**, with **3 opt-in native tests skipped**, and no failures.
Type checking, lint, generated-plugin checks, Svelte checking, and the production
viewer build passed. The build retains its existing large-chunk advisory.

The compact-record regression test also verifies that source and Markdown
bodies remain readable on demand, evidence preserves Unicode and fence
exclusion, and a full projection rebuild reproduces the graph and feed excerpt.
Existing tests cover revision publication, nested snapshots, recovery, aliases,
supersession, source settlement, and note access policies.
