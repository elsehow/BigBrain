import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation } from 'd3-force';
import { graphIdentityIndex } from '../../../../lib/graphIdentity';
import { personalizedPageRank, BRIEFING_DEGREE_DISCOUNT } from '../../../../lib/graphImportance';
import type { GraphViewState } from '../../../../lib/graphView';
import type { GraphData } from './types';

export const SELECTION_DETAIL = 60;
const cache = new WeakMap<GraphData, Map<string, GraphData>>();

/** Score the complete graph; budget the view, not the random walk. Connecting
 * paths count toward the budget so relevance never produces floating islands. */
export function selectionSubgraph(graph: GraphData, view: GraphViewState, focus: string | null): GraphData {
  const roots = view.selected.length ? view.selected : focus ? [focus] : [];
  if (!roots.length && !view.excluded.length) return graph;
  const key = JSON.stringify([[...new Set(roots)].sort(), [...new Set(view.excluded)].sort()]);
  let entries = cache.get(graph);
  if (!entries) { entries = new Map(); cache.set(graph, entries); }
  const cached = entries.get(key);
  if (cached) return cached;
  const index = graphIdentityIndex(graph.nodes);
  const excluded = new Set(view.excluded.map(id => index.get(id)));
  const adjacency = graph.nodes.map(() => new Set<number>());
  const edges = graph.edges.flatMap(e => {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b || excluded.has(a) || excluded.has(b)) return [];
    adjacency[a]!.add(b); adjacency[b]!.add(a);
    return [{ ...e, source: graph.nodes[a]!.id, target: graph.nodes[b]!.id }];
  });
  const seeds = [...new Set(roots.flatMap(id => {
    const i = index.get(id); return i === undefined || excluded.has(i) ? [] : [i];
  }))];
  const walk = adjacency.map(neighbors => [...neighbors]);
  const personal = personalizedPageRank(walk, seeds);
  const scores = Array.from(personal, (p, i) => p / Math.pow(Math.max(1, walk[i]!.length), BRIEFING_DEGREE_DISCOUNT));
  const order = graph.nodes.map((_, i) => i).filter(i => !excluded.has(i) && scores[i]! > 0)
    .sort((a, b) => scores[b]! - scores[a]! || graph.nodes[a]!.id.localeCompare(graph.nodes[b]!.id));
  // High-scoring predecessors win ties among equally short seed paths.
  const parent = new Int32Array(graph.nodes.length).fill(-1), queue = [...seeds];
  for (const seed of seeds) parent[seed] = seed;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    for (const j of [...walk[i]!].sort((a, b) => scores[b]! - scores[a]! || a - b)) {
      if (parent[j] !== -1) continue;
      parent[j] = i; queue.push(j);
    }
  }
  const keep = new Set(seeds), limit = Math.max(SELECTION_DETAIL, seeds.length);
  for (const i of order) {
    const path: number[] = [];
    for (let j = i; !keep.has(j) && j >= 0; j = parent[j]!) path.push(j);
    if (keep.size + path.length > limit) continue;
    for (const j of path) keep.add(j);
    if (keep.size === limit) break;
  }
  // An exclusion-only view preserves the overview semantics.
  if (!roots.length) graph.nodes.forEach((_, i) => { if (!excluded.has(i)) keep.add(i); });
  const ids = new Set([...keep].map(i => graph.nodes[i]!.id));
  const subsetEdges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const degree = new Map<string, number>();
  for (const e of subsetEdges) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const seedSet = new Set(seeds);
  const maximum = Math.max(1e-15, ...order.filter(i => !seedSet.has(i)).map(i => scores[i]!));
  const nodes = graph.nodes.flatMap((n, i) => !keep.has(i) ? [] : [{ ...n, degree: degree.get(n.id) ?? 0,
    relevance: seedSet.has(i) ? 1 : .85 * Math.pow(scores[i]! / maximum, .4),
    selectionPath: (() => {
      const path = [i];
      for (let j = i; parent[j]! >= 0 && parent[j] !== j; ) { j = parent[j]!; path.push(j); }
      return path.reverse().map(j => graph.nodes[j]!.id);
    })(), memorySupport: undefined, layoutAnchors: undefined }]);
  if (roots.length && nodes.length) {
    const points = nodes.map((n, i) => {
      const seed = seedSet.has(index.get(n.id)!);
      const rank = seeds.indexOf(index.get(n.id)!);
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const radius = 100 + 240 * (1 - n.relevance);
      const anchor = seeds.length === 1 ? { x: 0, y: 0 } : { x: 70 * Math.cos(rank * 2 * Math.PI / seeds.length), y: 70 * Math.sin(rank * 2 * Math.PI / seeds.length) };
      return { id: n.id, x: seed ? anchor.x : radius * Math.cos(angle), y: seed ? anchor.y : radius * Math.sin(angle),
        fx: seed ? anchor.x : undefined, fy: seed ? anchor.y : undefined, radius };
    });
    const simulation = forceSimulation(points).stop()
      .force('links', forceLink(subsetEdges.map(e => ({ source: e.source, target: e.target }))).id(n => (n as typeof points[number]).id).distance(80).strength(.12))
      .force('charge', forceManyBody().strength(-95))
      .force('collision', forceCollide(18))
      .force('relevance', forceRadial<typeof points[number]>(p => p.radius).strength(.18));
    simulation.tick(100);
    nodes.forEach((n, i) => { n.x = points[i]!.x; n.y = points[i]!.y; });
  }
  const result: GraphData = { ...graph, layoutBase: undefined, selectionRelative: !!roots.length,
    hash: JSON.stringify([graph.hash, key]), nodes, edges: subsetEdges };
  if (entries.size >= 12) entries.delete(entries.keys().next().value!);
  entries.set(key, result);
  return result;
}
