import type { GraphNode } from '../types';
import { fitCamera, type Box, type Room } from './framing';

/** Stable landmarks spread across the neighborhood, rather than all its hubs. */
export function neighborhoodLandmarks(nodes: readonly GraphNode[], roots: ReadonlySet<number>, limit = 4): Set<number> {
  const chosen = new Set<number>();
  const distance = (a: number, b: number) => Math.hypot((nodes[a]!.x ?? 0) - (nodes[b]!.x ?? 0), (nodes[a]!.y ?? 0) - (nodes[b]!.y ?? 0));
  const span = Math.max(1, Math.hypot(Math.max(...nodes.map(n => n.x ?? 0)) - Math.min(...nodes.map(n => n.x ?? 0)), Math.max(...nodes.map(n => n.y ?? 0)) - Math.min(...nodes.map(n => n.y ?? 0))));
  const candidates = nodes.map((_, i) => i).filter(i => !roots.has(i) && nodes[i]!.degree >= 2 && (nodes[i]!.relevance ?? 0) >= .08);
  while (chosen.size < limit && candidates.length) {
    const anchors = [...roots, ...chosen];
    const score = (i: number) => {
      const separation = anchors.length ? Math.min(...anchors.map(j => distance(i, j))) / span : 1;
      return Math.sqrt(nodes[i]!.relevance ?? 0) * Math.min(1, separation / .3);
    };
    candidates.sort((a, b) => score(b) - score(a) || nodes[a]!.id.localeCompare(nodes[b]!.id));
    const next = candidates.shift()!;
    if (anchors.length && Math.min(...anchors.map(j => distance(next, j))) < span * .13) continue;
    chosen.add(next);
  }
  return chosen;
}

/** Balance visual mass slightly above/left of center while keeping the entire
 * silhouette within the available room. No clipping of low-ranked outliers. */
export function composeNeighborhood(box: Box, room: Room, nodes: readonly GraphNode[]) {
  const fit = fitCamera(box, room), inside = Math.max(1, room.h - room.top - room.bottom);
  let x = 0, y = 0, weight = 0;
  for (const node of nodes) {
    const w = .25 + (node.relevance ?? 0);
    x += (node.x ?? 0) * w; y += (node.y ?? 0) * w; weight += w;
  }
  if (!weight) return fit;
  const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
  return { ...fit,
    tx: clamp(room.w * .46 - x / weight * fit.scale, room.w * .05 - box.minX * fit.scale, room.w * .95 - box.maxX * fit.scale),
    ty: clamp(room.top + inside * .46 - y / weight * fit.scale, room.top + inside * .05 - box.minY * fit.scale, room.top + inside * .95 - box.maxY * fit.scale),
  };
}
