# Shared search

The viewer, CLI, HTTP API and MCP readers use `scanSurface` in
`lib/searchCore.ts`. Reader searches combine the source/assertion/entity
index with current `memory/**/*.md`. Memory is searched in place and never
ingested as new evidence. Edits, additions and deletions take effect on the
next search; no reindex or memory run is needed.

Exact names rank ahead of name prefixes, then body matches. Within the same
relevance tier, curated memory leads record hits. Equally relevant topic
files precede `memory/MEMORY.md`. A stronger record name match still beats
a memory body match. Record ordering is otherwise preserved, and the result
limit applies after merging memory. Use response order for ranking; `score`
alone does not encode the relevance tiers or memory preference.

Memory hits carry `evidence: "memory"`, an empty event date, and a path that
opens through the usual note reader. Their citations lead to the underlying
record. `load_memory` and `memory.sh` remain available for direct reads.
Explicit date or record-type filters exclude memory because a summary has
neither an event date nor a reference/entity type.

Search terms use the existing prefix matching, with all terms required
first and any-term relaxation on zero results. Memory-only matches count
before deciding whether to relax.

Ingestion keeps its record-only search: authenticated `via=gardener` HTTP
searches, gardener MCP searches, and CLI machine roles other than `memory`
exclude the working set. Ordinary assistant searches include memory by
default. This preserves the boundary between evidence and its summaries.
