import type { GraphData } from '../types';

/** A few quiet links suggest structure; nodes need not all have a drawn edge.
 * Degree caps avoid turning the selected hub into a wheel of spokes. */
export function selectionEdges(graph: GraphData): Set<number> {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const order = graph.edges.map((e, i) => ({ i, e, score: Math.sqrt((nodes.get(e.source)?.relevance ?? 0) * (nodes.get(e.target)?.relevance ?? 0)) }))
    .sort((a, b) => b.score - a.score || a.e.source.localeCompare(b.e.source) || a.e.target.localeCompare(b.e.target));
  const kept = new Set<number>(), degree = new Map<string, number>();
  const budget = Math.min(16, Math.max(1, Math.round(graph.nodes.length / 5)));
  for (const { i, e } of order) {
    if ((degree.get(e.source) ?? 0) >= 2 || (degree.get(e.target) ?? 0) >= 2) continue;
    kept.add(i);
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    if (kept.size >= budget) break;
  }
  return kept;
}
