# Note briefings

Selecting an entity, source (including a source thread), memory, or dropped
Markdown note shows one Quick-model reading aid: a single short summary sentence
(ideally 10–20 words) followed by up to ten relationship descriptions total.
The summary identifies the item; collaborators and relationship details belong
in the links. Selecting several nodes uses the same one-sentence format focused
on their relationship or shared context, with all selected names in the title.
The graph and text tab share `{ selected, excluded }` membership.
The bottom panel contains only the selected note or combined selection;
Recent/Top tabs and note-type chips are absent. With no selection the panel
is hidden. The rounded HUD header names the selection, shows its last recorded update when
available, and carries Discuss, navigation, history, source Open, and relationship
selection shortcuts. Command-O opens the original source when one is available.
Enter selects the highlighted relationship as a new single selection. Shift-Enter
keeps the Discuss action and temporary Copied feedback, including while a
relationship is highlighted. A two-column body places the
summary on the left and relationships on the right, with independent scrolling.
The whole relationship row is clickable and inverts on hover or keyboard
selection; Shift-click adds its record to the current selection, matching the
graph gesture. Narrow screens stack the columns. The panel has a brief rise/fade on
opening and its text a shorter reveal; reduced-motion preferences disable both.
The search bar stays visible whenever a note is selected.

Search keeps the current selection and briefing visible. Three rows at a time
float directly beneath the full-width search field, aligned to its edges,
with note titles, small entity/memory/source labels, and an active-row
highlight. Focusing an empty field (including / or Command-K) shows the source
arrival feed, newest first. Both recents and search use a fixed 108px scrolling
viewport with single-line titles. Twelve recent rows or six search hits load
ahead of the three visible rows. Scrolling near the end requests another page.
A shared small spinner indicates initial and further loading, with no loading
text; the next-page spinner stays visible inside the viewport. Failed pages
retain a retry. Earlier rows scroll
out of view; the popup never grows beyond three rows. Arrows scroll the cursor
into view and fetch the next page at the end. Each new query or reopening starts
on the first hit, and Enter opens immediately. Hover
and keyboard navigation preview the highlighted neighborhood in the graph
without generating a briefing or replacing the committed selection. Pending
results cannot open a previous query's hit, and Escape dismisses search
before closing the selected note. Tab follows normal focus order.

The floating omnibox debounces only new typed queries (50 ms), with no debounce
on recents or additional pages. Up to 32 completed pages are cached for 15 seconds. Keys include query, page offset,
and live vault revision; errors and superseded requests are never cached.
Recents use the existing arrival-feed offsets. Search uses offsets over ranked
hits (within the existing 250-hit search cap), with one lookahead hit to detect
the last page. Thread paths repeated across pages are deduplicated on append.
Loading another page preserves existing rows and the cursor; changing queries
or dismissing the popup cancels the request. The initial recent-page warm is
shared across openings and completes even when the popup is dismissed. It runs
at startup and on live revisions. Recents paint synchronously from the existing
memory/session cache while revalidating; that cache survives a reload or revision,
and background refresh preserves the highlighted path. The
desktop recent palette retains its 100-result request. Before pagination, on the disposable
3,983-node snapshot in Chrome, five name-search samples took 248–289 ms from
input to the next paint before these changes (151–155 ms debounce,
83–126 ms request). Five uncached case variants afterward took 103–155 ms
(51–52 ms debounce, 43–93 ms request), and cached repeats took 6–9 ms.
These are local samples, not a bound or a Zen measurement. Search uses the
local projection and memory files; no model API participates.

Profiling recents on the disposable snapshot (2,980 feed rows) found 650–690 ms
in the local endpoint plus 54–57 ms debounce, yielding 806–816 ms first-open
samples in Chrome. The endpoint rebuilt all rows and normalized complete source
bodies for each tiny page. Excerpts now stop after 240 output characters, and
all page offsets share one cached feed, invalidated immediately by the vault
watcher with a 60-second fallback expiry. Direct cached feed reads measured
below 0.1 ms; the initial cold build still took 1.24 seconds in a fresh process.
With startup prefetch and browser cache reuse, the same browser script measured
19–42 ms openings across two page loads, with no recent request on the focus
path. These are local Chrome samples, not a cold-start or Zen guarantee.

Up to three inbound memory files also supply relevant excerpts, even when all
ten described links are entities. These passages come from explicit backlinks
or cited assertions in the memory, not from a source merely mentioning a memory.
Selection coverage comes first when choosing excerpts, followed by the existing
candidate order. The extra context uses at most 3,000 characters taken from the
16,000-character selected-note budget; it adds no model call or output links.
Excluded memories and owner nodes remain absent. Memory context can inform the
summary, while link descriptions still require their own supplied evidence.

Candidate links are deduplicated across selections. Shared connections rank
first by the number of selected anchors they touch, then selection-relative
PageRank determines the order within each coverage tier, regardless of note
type. Selected nodes, exclusions, and the vault owner's hidden nodes are
omitted. Quick receives the first ten candidates in this order
and writes a 3–5 word clause after each linked title. Extra words are allowed
for essential uncertainty or to identify which selected item is meant. Every
remaining connection follows as a plain link in candidate order. Ten is the
total cap even when several items are selected; shared links appear once.
The HUD always keeps this graph-derived order: streamed and cached descriptions
fill existing rows by node ID. Legacy caches are reordered without regenerating
their prose. Long titles truncate to one line; hovering or focusing a truncated
row reveals its full title.

The local score is personalized PageRank divided by degree raised to 0.25.
Walks use the whole undirected graph with exclusions removed, restart equally
at selected anchors with probability 0.3, and stop after convergence or 64
iterations. Only direct neighbors become candidates. This favors the selected
neighborhood while mildly discounting global hubs. The overview separately
prioritizes [memory backlinks](connection-ranking.md#overview-importance-from-memories).
Full degree normalization was compared and
overpromoted sparsely connected leaves. This remains a structural heuristic,
not a semantic guarantee. [Comparison and reproduction](connection-ranking.md).

j/k walks that complete displayed order; Enter selects the current link as a new
single selection. The whole row, including its description, is clickable and
highlighted. Names and descriptions occupy separate columns, without evidence
tooltips. All graph links remain
usable while Quick loads or fails. A streamed summary stays visible if
relationship generation fails, alongside a separate retry status. Retrying or
refreshing the same selection retains that summary until a complete replacement
arrives; switching selections clears it. Failed responses never enter the
completed-briefing cache. Original Markdown and source/discussion
controls remain available for a single selection. Claude schema failures are
repaired automatically inside the same SDK session, with at most two retries.
The user sees an error and Retry only if that bounded recovery fails. Later
repair attempts cannot overwrite the first streamed summary with partial text.

## API and grounding

`POST /api/note/briefing` accepts either `{ "path": "memory/topic.md" }` or
`{ "selected": ["alpha", "beta"], "excluded": ["shared"] }` and returns
`{ "briefing": { "key", "model", "generatedAt", "summary", "links" } }`.
IDs, note paths, folded aliases, and source import paths resolve to canonical
nodes. Order and duplicate IDs do not change a selection's cache identity.
Each link has an `id`, `path`, `title`, and `evidence`; the first ten or fewer
also have `description`. This is a reading aid, never an assertion or vault edit.
Older entity/source briefing endpoints remain available.

Add `"stream": true` for newline-delimited JSON events: `preview` carries plain
summary `text`; `complete` carries the validated `briefing`; `error` carries a
retryable `error`. The summary arrives before the full JSON response; generated
link descriptions and ordering appear only after validation.

The graph and reading aid share assertion connections and resolved internal
Markdown links: wikilinks, inline/reference links, source-body links, memory
backlinks, and assertion citations that resolve to entities. Code examples,
broken/ambiguous targets, external URLs, and the owner's entity and owner-named
memory index are excluded. Sources that mention the owner remain navigable.
Only readable targets participate; lexical and real-path checks confine Markdown
reads to the viewer's content trees.

One Quick request receives a summary task first, followed by bounded note text,
memory excerpts, and evidence for ten neighbors. For a multi-selection with direct
relationships, that task carries only the bounded direct evidence and requires a close
paraphrase that retains uncertainty; otherwise it selects shared-context or single-item
identity behavior. Each neighbor and evidence row
identifies which selected anchors it connects to. The prompt judges relevance
from evidence without preferring any note type and explicitly forbids inferring
collaboration from a shared neighbor alone. The total neighbor
evidence budget remains about 15,000 characters: ten candidates get up to 1,500
characters each, while five or fewer retain up to 3,000 each. The output ceiling
is 1,400 tokens, allowing ten short descriptions without truncation. Short handles give
the model no authority to invent paths. Validation rejects unknown, duplicate,
or missing supplied targets and invalid evidence indices.

Claude uses the Agent SDK's `outputFormat: { type: "json_schema", schema }`,
including with subscription authentication. The schema is generated from the
shortlist: `links` is an object with required `L1`, `L2`, etc. keys, and each
link requires a description and a nonempty array drawn only from its own valid
evidence indices. This catches missing references, wrong types, omitted targets,
and out-of-range indices before the SDK returns success. Evidence passages now
carry explicit indices in the prompt. The server maps the validated object back
to the existing ranked link array and checks it again. Older array responses
remain readable; valid completed caches continue to work.

`MAX_STRUCTURED_OUTPUT_RETRIES=2` caps the SDK's schema repairs. There is no
outer retry loop multiplying that limit. Four agentic turns allow submission
and repair; the existing 60-second inference timeout and $0.15 SDK session budget
still apply across those turns. Authentication, connection, time, and budget
failures remain terminal. The Codex Quick path retains plain JSON and the server
validator; these SDK schema retries apply to Claude.

The validated `structured_output` arrives only in the final result. The installed
SDK also emits raw `StructuredOutput` tool-input deltas: those supply the
provisional summary, while descriptions wait for the final validated object.
Other tool arguments and free-form model text are ignored in structured mode.
The internal output tool is the only added capability; filesystem, network, MCP,
and other agent tools remain disabled. Schema validation binds references to
supplied evidence; it does not prove that the prose accurately interprets it.

## Caching and latency

Completed briefings paint synchronously from a browser cache on revisits,
including the generated link order. Memory holds up to 32 recent views;
`sessionStorage` retains completed responses across reloads when available.
Background revalidation preserves that view, including during an API failure.
Only uncached views show a loading state. A 150 ms debounce coalesces rapid
selection changes before requesting fresh work; it never delays a cached paint.
Partial, failed, and superseded responses do not replace cached output.

The server's disposable `.state/note-briefings/` cache is keyed by canonical
selection/exclusions, content and evidence, candidate order, prompt version,
and Quick provider/model. Concurrent readers share a generation. Different
selections generate concurrently, including while earlier selections finish
in the background after navigation; there is no two-briefing rejection. Graph and
entity records reuse their memoized input while a healthy filesystem watcher
provides invalidation; without a watcher they retain the 60-second TTL fallback.
The graph also checks the projection database/WAL stamp. Markdown scanning avoids
repeated full-document searches, and graph construction seeds the entity record
cache from the same logs.

After a briefing, the engine prepares one idle Claude SDK client with that
schema without submitting a prompt. A later request can reuse it only if its
schema shape, provider settings, and budgets match; otherwise it is closed and
a fresh client starts. Opening the graph no longer warms an unconstrained client
that cannot serve the required schema. No conversation context is shared across
notes. The idle client expires after a minute. Haiku remains
the default: the available OpenAI models were slower through the local Codex
integration in the measured synthetic fixture. See [latency measurements](note-briefing-latency.md).

## Verification

- `bun test test/structuredBriefing.test.ts test/noteBriefing.test.ts test/noteBriefingStream.test.ts test/graphImportance.test.ts test/graphView.test.ts test/graphCache.test.ts test/liveEvents.test.ts test/codex.test.ts`
- `bun run typecheck` and `bun run lint`; in `web/ui`, `bun run check` and `bun run build`
- With Vite on :5198: `PLAYWRIGHT_MODULE=/path/to/playwright node test/support/noteBriefing.browser.cjs` and `node test/support/selectionBriefing.browser.cjs`
- Workbench: `/dev.html?c=briefings&s=joint&preview=1` (also ready, many, memory, source, streaming, loading, error)

The 600-link regression verifies that exactly ten links enter the model call
while every link remains navigable. Browser tests cover real graph modifiers,
combined titles, stable PageRank order, j/k/Enter, exclusions, debounce, stale responses,
streaming, immediate cached revisits during a delayed response, mobile wrapping,
and failure states. Browser fixtures block all real API traffic. Model timing
checks use entirely fabricated notes; real snapshot profiling stays local and
only measures graph construction and evidence preparation.
