import type { GraphData } from "../lib/types";
import { sourcesNewestFirst, type EntitySource } from "../../../../lib/views/entitySources";
import type { V2FeedRow, V2SortedRow } from "../../../../lib/views/v2Feed";

const ATLAS = "projection/entities/ent_00000000000000000001.md";
const UPDATE = "log/insertions/2026-09/ins_000000000000000000000001.json";
const PROPOSAL = "sources/atlas-expansion-proposal.md";
const samples = [
    { id: UPDATE, path: UPDATE, added: "2026-09-12T12:00:00Z", via: "Web", title: "Atlas — September update",
      excerpt: "The lease fell through; the second location is postponed while Maya looks for another space." },
    { id: PROPOSAL, path: PROPOSAL, added: "2026-08-26T12:00:00Z", via: "Document", title: "A second home for Atlas",
      excerpt: "The original expansion proposal: bring the tool library closer to more neighbors." },
];
const bodies: Record<string, string> = {
  [UPDATE]: "Our proposed second location is on hold. The lease fell through this month, so we’re returning to the search for a suitable space.\n\nMaya Chen is coordinating the next round of visits. We still want a location that is easy to reach and has enough room for tools, repairs, and volunteer-led workshops.\n\n> The expansion is postponed, but the neighborhood library and its regular borrowing hours continue.\n\nWe’ll share another update when there is a concrete option to consider.",
  [PROPOSAL]: "The expansion should make borrowing a tool feel as straightforward as borrowing a book. A second location would bring Atlas closer to more neighbors.\n\nKeep the borrowing desk visible from the entrance. Put frequently used tools within easy reach, and leave a flexible area for repairs and small workshops.\n\n> A welcoming space and a simple borrowing process matter more than filling every shelf on day one.\n\nMaya will bring these decisions into the next discussion about a possible location.",
};

/** Uses the real shell, graph, search and reader with invented local responses. */
export async function installSourceStudy(): Promise<void> {
  const state = new URLSearchParams(location.search).get('sourceState');
  const sources = state === 'many' ? [...samples, ...Array.from({ length: 10 }, (_, i) => ({
    id: `sample-archive-${i}`, path: `sources/sample-archive-${i}.md`, title: `Atlas archive ${i + 1}`,
    added: `2026-07-${String(20 - i).padStart(2, '0')}T12:00:00Z`, via: 'Document', excerpt: `An earlier planning note about Atlas, number ${i + 1}.`,
  }))] : samples;
  let sourceReads = 0;
  const previous = window.fetch.bind(window);
  const graph: GraphData = await (await previous('/api/graph')).json();
  for (const node of graph.nodes) if (node.group === 'entity') node.entity = true;
  graph.nodes.push({ id: PROPOSAL, path: PROPOSAL, title: "A second home for Atlas", group: "source", degree: 2, x: -30, y: 40 });
  graph.edges.push({ source: PROPOSAL, target: ATLAS }, { source: PROPOSAL, target: "maya" });
  // The real graph joins concepts through shared sources; add the same ties
  // explicitly to this older sample graph so the neighborhood remains useful.
  graph.edges.push({ source: ATLAS, target: "maya", weight: 2 });
  graph.hash = 'concept-sources-study';
  const sorted: V2SortedRow[] = sources.map(source => ({ source: source.path, section: 'know', headline: source.excerpt,
    due: null, added: source.added, entities: [ATLAS, 'maya'], title: source.title, path: source.path, via: source.via }));
  const feed: V2FeedRow[] = sources.map((source, i) => ({ id: `sample-source-claim-${i}`, at: sorted[i]!.added,
    author: 'gardener', by: 'Sample gardener', model: true, text: source.excerpt, entities: [ATLAS, 'maya'] }));
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/graph') return json(graph);
    // This source-reading scene has no conversations. The older general
    // fixture otherwise supplies legacy sessions and fills the top bar.
    if (url.pathname === '/api/pilot/chat') return json({ sessions: [] });
    if (url.pathname === '/api/v2') return json({ authors: [], feed });
    if (url.pathname === '/api/v2/sorted') return json({ rows: sorted, next: null });
    if (url.pathname === '/api/v2/entity/sources') {
      if (state === 'error' && sourceReads++ === 0) return new Response('Unavailable', { status: 503 });
      if (state === 'empty') return json({ sources: [] });
      const related = [ATLAS, 'maya'].includes(url.searchParams.get('id') ?? '') ? sources : [];
      return json({ sources: related.map(({ id, path, title, added, via }): EntitySource => ({ id, path, title, added, via })).sort(sourcesNewestFirst) });
    }
    if (url.pathname === '/api/v2/entity') return json({ rows: feed.filter(r => r.entities.includes(url.searchParams.get('id') ?? '')) });
    if (url.pathname === '/api/note') {
      const source = sources.find(s => s.path === url.searchParams.get('path'));
      if (source) return json({ path: source.path, byAgent: true, content: `---\ntype: source\ntitle: "${source.title}"\nsource_id: ${source.via.toLowerCase()}-sample\ndate: ${sorted.find(r => r.path === source.path)!.added}\n---\n# ${source.title}\n\n${bodies[source.path] ?? source.excerpt}`, origin: null });
    }
    if (url.pathname === '/api/note/briefing') {
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const source = sources.find(s => s.path === request.path);
      if (source && state === 'summary-error') return new Response(JSON.stringify({ type: 'error', error: 'Quick unavailable' }) + '\n');
      if (source || request.path === ATLAS) return new Response(JSON.stringify({ type: 'complete', briefing: {
        summary: source?.excerpt ?? 'Atlas is a volunteer-run neighborhood tool library. Maya Chen coordinates its proposed expansion to a second location.', links: [],
      } }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    }
    return previous(input, init);
  }) as typeof window.fetch;
}
