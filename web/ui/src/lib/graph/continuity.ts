import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { GraphData } from '../types';
import type { Point } from './camera';

/** Relax the next neighborhood from the picture the user already knows. */
export function continueNeighborhood(graph: GraphData, previous: ReadonlyMap<string, Point>, selected: ReadonlySet<string>): { from: Point[]; to: Point[] } {
  const neighbors = new Map(graph.nodes.map(n => [n.id, [] as string[]]));
  for (const e of graph.edges) { neighbors.get(e.source)?.push(e.target); neighbors.get(e.target)?.push(e.source); }
  const known = graph.nodes.flatMap(n => previous.has(n.id) ? [previous.get(n.id)!] : []);
  const center = { x: known.reduce((s, p) => s + p.x, 0) / Math.max(1, known.length), y: known.reduce((s, p) => s + p.y, 0) / Math.max(1, known.length) };
  const points = graph.nodes.map((n, i) => {
    const old = previous.get(n.id), near = (neighbors.get(n.id) ?? []).flatMap(id => previous.has(id) ? [previous.get(id)!] : []);
    const origin = old ?? (near.length ? { x: near.reduce((s, p) => s + p.x, 0) / near.length, y: near.reduce((s, p) => s + p.y, 0) / near.length } : center);
    const x = origin.x + (old ? 0 : 10 * Math.cos(i * 2.399963)), y = origin.y + (old ? 0 : 10 * Math.sin(i * 2.399963));
    return { id: n.id, x, y, anchorX: x, anchorY: y, shared: !!old, fx: old && selected.has(n.id) ? x : undefined, fy: old && selected.has(n.id) ? y : undefined };
  });
  const from = points.map(p => ({ x: p.x, y: p.y }));
  forceSimulation(points).stop()
    .force('links', forceLink(graph.edges.map(e => ({ source: e.source, target: e.target }))).id(n => (n as typeof points[number]).id).distance(48).strength(.055))
    .force('charge', forceManyBody().strength(-24))
    .force('collision', forceCollide(8))
    .force('x', forceX<typeof points[number]>(p => p.anchorX).strength(p => p.shared ? .22 : .025))
    .force('y', forceY<typeof points[number]>(p => p.anchorY).strength(p => p.shared ? .22 : .025))
    .tick(65);
  return { from, to: points.map(p => ({ x: p.x, y: p.y })) };
}
