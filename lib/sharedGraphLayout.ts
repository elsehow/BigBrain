import type { Graph } from './graph';
import { computeLayout, type Positions } from './graphLayout';
// Connection-filtered pictures have their own bounded cache, never the personal
// vault's persisted layout. Keep established personal positions as the warm start.
const layouts = new Map<string, Positions>();
export function sharedGraphLayout(graph: Graph): Graph {
 if (graph.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))) return graph;
 let positions = layouts.get(graph.hash);
 if (!positions) {
  const previous: Positions = {};
  for (const n of graph.nodes) if (Number.isFinite(n.x) && Number.isFinite(n.y)) previous[n.id] = [n.x!, n.y!];
  positions = computeLayout(graph, previous);
  if (layouts.size >= 8) layouts.delete(layouts.keys().next().value!);
  layouts.set(graph.hash, positions);
 }
 return {...graph, nodes: graph.nodes.map(n => ({...n, x: positions[n.id]![0], y: positions[n.id]![1]}))};
}
