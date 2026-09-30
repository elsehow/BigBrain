import { graphIdentityIndex } from '../../../../lib/graphIdentity';
import type { GraphViewState } from '../../../../lib/graphView';
import type { GraphData } from './types';

/** Resolve membership against the complete graph, including on repeated selection.
 * Drop layoutBase: the subset must own its layout, degrees and importance. */
export function selectionSubgraph(graph: GraphData, view: GraphViewState, focus: string | null): GraphData {
  const index = graphIdentityIndex(graph.nodes);
  const excluded = new Set(view.excluded.map(id => index.get(id)));
  const roots = view.selected.length ? view.selected : focus ? [focus] : [];
  if (!roots.length && !view.excluded.length) return graph;
  const adjacency = graph.nodes.map(() => new Set<number>());
  const edges = graph.edges.flatMap(e => {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || excluded.has(a) || excluded.has(b)) return [];
    adjacency[a]!.add(b); adjacency[b]!.add(a);
    return [{ ...e, source: graph.nodes[a]!.id, target: graph.nodes[b]!.id }];
  });
  const keep = roots.length ? new Set(roots.flatMap(id => {
    const i = index.get(id); return i === undefined || excluded.has(i) ? [] : [i];
  })) : new Set(graph.nodes.flatMap((_, i) => excluded.has(i) ? [] : [i]));
  let frontier = [...keep];
  for (let hop = 0; hop < 2 && roots.length; hop++) {
    const next: number[] = [];
    for (const i of frontier) for (const j of adjacency[i]!) if (!keep.has(j)) { keep.add(j); next.push(j); }
    frontier = next;
  }
  const ids = new Set([...keep].map(i => graph.nodes[i]!.id));
  const subsetEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const degree = new Map<string, number>();
  for (const e of subsetEdges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  return { ...graph, layoutBase: undefined, hash: JSON.stringify([graph.hash, [...ids].sort()]),
    nodes: graph.nodes.filter(n => ids.has(n.id)).map(n => ({ ...n, degree: degree.get(n.id) ?? 0,
      memorySupport: undefined, layoutAnchors: n.layoutAnchors?.filter(id => ids.has(graph.nodes[index.get(id) ?? -1]?.id ?? '')) })),
    edges: subsetEdges };
}
