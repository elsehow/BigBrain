# Shared context connection ranking

The production mention menu, note sidebar, and Quick prompt now call
`contextConnections` (`lib/contextConnections.ts`). Explicit references in
selected memory text lead, followed by summed direct connection weight.
Ties use the selection-relative ranking described below, then stable node
identity. Pilot/session nodes are excluded from this ranking. Recency and
agent activity do not change connection order. Quick describes the first ten
connections; the remaining links retain the same order without descriptions.

Successful production memory passes warm each topic's Quick briefing cache
sequentially. Content/evidence changes invalidate entries; failures leave the
committed memory intact and permit on-demand retry. The root memory index is
excluded from warming and from the home memory carousel.

## Selection-relative tie breaker

Briefing candidates previously used the same hub prominence score as the graph
appearance. A broadly connected entity could therefore enter a note's top five
without being particularly relevant to that note. Haiku could reorder those
five, but could not choose a candidate outside that cutoff.

The new default is personalized PageRank with a mild degree discount:

```
score(v) = PPR(selected anchors, v) / degree(v)^0.25
```

The walk uses the complete undirected, deduplicated graph, removing explicitly
excluded nodes and their incident edges. Each step restarts uniformly among
selected anchors with probability 0.3; otherwise it follows a uniformly chosen
edge. Dangling mass returns to the seed distribution. Iteration ends at an L1
change below 1e-9 or 64 passes. Edge multiplicity, assertion count, live-session
status, and timestamps do not weight this walk. Results are rounded to 1e-12
for deterministic identity-based ties across graph/ingestion order changes.

Only existing direct neighbors enter the candidate list. Shared-anchor coverage
still ranks first for multi-selection, then this score decides order within each
coverage tier. Entities, memories, sources, and other Markdown compete equally;
neither the shortlist nor Haiku's prompt has a type preference. Haiku receives exactly the first ten
candidates total (or fewer when unavailable), with the existing total evidence
budget divided across them. The limit applies to the combined selection. It
describes them without reranking; the complete list keeps candidate order.
Frontend rendering and backend generation use `briefingConnections`. Responses
only enrich the existing rows by ID, including responses from older caches.
This selection-relative walk is separate from overview importance below; node
sizes continue to reflect degree.

## Overview importance from memories

Desktop text search and typed `@` mentions reuse this importance policy through
`lib/navigationSearch.ts`. Exact titles or aliases rank first, then titles
containing all query terms, then body/retrieval matches. Within a text tier,
shared graph importance orders results, followed by conversation demotion and
recency. Mentions additionally prefer notes/entities over conversations within
the same text tier. Pilots join that order rather than being prepended.
The web search ranks and deduplicates its bounded candidate pool before slicing
pages. Bare `@` remains chronological recents. Agent/CLI retrieval keeps its
existing evidence-oriented ranking.

The overview and Top tab now prioritize memory backlinks. Each distinct memory
contributes `1 / sqrt(number of distinct visible targets)` to each target, counting
both explicit internal links and entity links resolved from assertion citations.
Repeated mentions, duplicate citations and aliases resolving to the same target
count once per memory. The builder preserves outgoing memory direction before
graph edges become undirected; a source that merely links to a memory earns no
support. Hidden owner nodes and the owner's hidden memory index do not vote or
affect the breadth denominator.

Memory-supported nodes rank above unsupported ordinary nodes. Weighted support
is primary (rounded to 1e-9 for stable ties); the previous logarithmic degree /
local-hub score breaks ties. Supported scores occupy the foreground band
0.72–1, unsupported scores stay at or below 0.68. Memory files themselves retain
their 1.12 prominence and active work retains 1.6. With no memory support, the
original connectivity ranking applies. GraphHierarchy and Top share the same
policy, including after activity updates. Node sizes still use degree.

The connected overview continues to grow through actual neighbors inside the
largest component, so bridge nodes may take a slot and isolated components can
remain outside the overview. This change does not alter selection-relative
PageRank, described-link membership, or the remainder's candidate order.

A local-only comparison on the disposable 3,983-node snapshot found 100 nodes
with memory support. The 180-node connected overview included 40 of them under
the former policy and all 100 with memory support prioritized. Warm scoring
medians were about 3 ms for both policies (five runs after a warmup). This is one
snapshot, not a semantic relevance benchmark. No model calls or uploads were
used. The graph hash includes support, so reversing a memory link invalidates
the view even when undirected topology is unchanged.

## Comparison

We compared the original ranking, plain personalized PageRank, full division by
degree, and weaker discounts on a local disposable snapshot (3,983 nodes,
11,266 edges). No model calls or external uploads were involved. Private note names and
passages are deliberately absent from this document.

In the motivating 143-neighbor example, an irrelevant global hub ranked first
under the old score, fourth under plain PageRank, 51st under full normalization,
and 49th under the chosen 0.25 discount. Full normalization moved too many
sparsely linked nodes above established local context. The milder discount also
preserved that same hub's first position for a separate, relevant selection.
This is a small qualitative comparison, not a relevance benchmark or a guarantee
that every selected link will be meaningful.

The final warm median for complete candidate ranking was 17.9 ms for the
143-neighbor selection and 17.0 ms for a 678-neighbor joint selection, versus
2.7 / 3.8 ms for the previous importance ranking. Each median uses five runs
after one warmup and excludes graph construction. No additional prompt tokens
or model calls are required. Completed browser cache hits continue to render
before revalidation. Cache versions changed to avoid reusing the former top five.

## Reproduction and checks

`bun test/support/profileConnectionRanking.ts` compares all four policies on a
fabricated graph: a local cluster beside an unrelated hub with 80 outside links.
The old policy puts the hub first; the new default puts it below the local cluster
while full normalization puts the rare leaf first. The prompt-cutoff test uses
a larger local cluster and verifies that the outsider remains below the new
ten-link shortlist.

To compare an already-exported scratch graph locally:

```
bun test/support/profileConnectionRanking.ts /private/tmp/scratch-graph.json 'node ID or exact title' 'optional second selection'
```

The comparison script reads only the specified JSON and prints top candidates
and elapsed time; it does not read a vault or call a model. Keep snapshot exports
and their output outside the repository.

Focused tests cover the walk's known two-node probabilities, mass conservation,
isolates, duplicate seeds/edges, canonical aliases, ordering stability, exclusions,
shared coverage, live-source independence, and the final ten-link prompt cutoff.
Browser regressions cover selection, keyboard order, streaming, and cached paint.
Run `bun test test/graphImportance.test.ts test/noteBriefing.test.ts test/noteBriefingStream.test.ts`.

Personalized PageRank and degree normalization are established graph techniques;
the 0.25 exponent here is an experimental application choice. Background:
[seed-relative ranking](https://arxiv.org/abs/1607.03483) and
[degree-normalized local graph clustering](https://www.math.ucsd.edu/~fan/wp/localpartition.pdf).
