import type { GraphData } from '../types';

/** A few quiet links suggest structure; nodes need not all have a drawn edge.
 * Degree caps avoid turning the selected hub into a wheel of spokes. */
export function selectionEdges(graph: GraphData): Set<number> {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const cloud = graph.selectionStyle === 'cloud';
  const parent = new Map(graph.nodes.map(n => [n.id, n.id]));
  const component = (id: string): string => { let p = id; while (parent.get(p) !== p) p = parent.get(p)!; return p; };
  const order = graph.edges.map((e, i) => ({ i, e, score: Math.sqrt((nodes.get(e.source)?.relevance ?? 0) * (nodes.get(e.target)?.relevance ?? 0)) /
      (cloud ? 30 + Math.hypot((nodes.get(e.source)?.x ?? 0) - (nodes.get(e.target)?.x ?? 0), (nodes.get(e.source)?.y ?? 0) - (nodes.get(e.target)?.y ?? 0)) : 1) }))
    .sort((a, b) => b.score - a.score || a.e.source.localeCompare(b.e.source) || a.e.target.localeCompare(b.e.target));
  const kept = new Set<number>(), degree = new Map<string, number>();
  const budget = cloud ? Math.min(54, Math.max(1, Math.round(graph.nodes.length * .45))) : Math.min(16, Math.max(1, Math.round(graph.nodes.length / 5)));
  const localBudget = cloud ? Math.ceil(budget * .85) : budget;
  const cap = cloud ? 3 : 2;
  for (const { i, e } of order) {
    if ((degree.get(e.source) ?? 0) >= cap || (degree.get(e.target) ?? 0) >= cap) continue;
    kept.add(i);
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    parent.set(component(e.source), component(e.target));
    if (kept.size >= localBudget) break;
  }
  if (cloud) for (const { i, e } of order) {
    if (kept.size >= budget) break;
    const a = degree.get(e.source) ?? 0, b = degree.get(e.target) ?? 0;
    if (kept.has(i) || !a || !b || a >= cap || b >= cap || component(e.source) === component(e.target)) continue;
    kept.add(i); degree.set(e.source, a + 1); degree.set(e.target, b + 1);
    parent.set(component(e.source), component(e.target));
  }
  return kept;
}
