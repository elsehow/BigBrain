import { nodeRadius, seedPosition } from "../../../../lib/graphGeometry";
import { importanceScores } from "../../../../lib/graphImportance";
import { overviewNodes, type GraphFocusStyle } from "./graphFocus";
import { cachedCompactOverview } from "./graphFocusCache";
import { createSessionSpacing } from "./graphSessionSpacing";
import type { GraphData } from "./types";

/** The vault's settled display layout is independent of transient session
 * nodes, attachment edges, and selection. Never solve 4,000 background nodes
 * again just because a composer opened, closed, or changed its context. */
export function createDisplayLayout(solve = cachedCompactOverview) {
  const spaceSessions = createSessionSpacing();
  let held: { base: GraphData; style: string; positions: Map<string, { x: number; y: number }>; overview: Set<string>; sessionAnchors: Map<string, { x: number; y: number }> } | undefined;
  return (graph: GraphData, focus: Readonly<GraphFocusStyle>): { x: number; y: number }[] => {
    const base = graph.layoutBase ?? graph;
    const style = JSON.stringify([base.hash, focus]);
    if (held?.base !== base || held.style !== style) {
      const nodes = base.nodes.map((n, i) => { const [x, y] = seedPosition(i); return { ...n, x: n.x ?? x, y: n.y ?? y, r: nodeRadius(n.degree) }; });
      const byId = new Map(nodes.map((n, i) => [n.id, i]));
      const adjacency = nodes.map((): number[] => []);
      for (const e of base.edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a !== undefined && b !== undefined) { adjacency[a]!.push(b); adjacency[b]!.push(a); }
      }
      const scores = importanceScores(adjacency, nodes.map(n => n.group === "memory"), Uint8Array.from(nodes, n => n.live ? 1 : 0), nodes.map(n => n.memorySupport ?? 0));
      const overview = overviewNodes(scores, focus.overviewCount, nodes.map(n => n.id), adjacency, focus.preferConnected);
      const settled = solve(nodes, adjacency, overview, focus.compactness);
      const positions = new Map(nodes.map((n, i) => [n.id, settled[i]!]));
      // Session placement follows the visible neighborhood of its context,
      // not the collision-expanded position reserved for a hidden source.
      // Multi-source BFS finds the closest overview node by real graph links.
      const owner = new Int32Array(nodes.length).fill(-1);
      const visible = nodes.map((_, i) => i).filter(i => overview[i]).sort((a, b) => nodes[a]!.id.localeCompare(nodes[b]!.id));
      const queue = [...visible];
      for (const i of visible) owner[i] = i;
      for (let k = 0; k < queue.length; k++) {
        const i = queue[k]!;
        for (const j of adjacency[i]!) if (owner[j] === -1) { owner[j] = owner[i]!; queue.push(j); }
      }
      const sessionAnchors = new Map<string, { x: number; y: number }>();
      for (const [i, n] of nodes.entries()) {
        let anchor = settled[i]!;
        if (!overview[i] && visible.length) {
          // Disconnected sources have no visible graph neighbor. Place their
          // overlay near the nearest visible point without inventing an edge.
          const nearest = owner[i]! >= 0 ? owner[i]! : visible.reduce((best, j) =>
            Math.hypot(settled[j]!.x - anchor.x, settled[j]!.y - anchor.y) < Math.hypot(settled[best]!.x - anchor.x, settled[best]!.y - anchor.y) ? j : best);
          const center = settled[nearest]!;
          const dx = anchor.x - center.x, dy = anchor.y - center.y;
          const scale = Math.min(1, 32 / (Math.hypot(dx, dy) || 1));
          anchor = { x: center.x + dx * scale, y: center.y + dy * scale };
        }
        for (const id of [n.id, n.path, ...(n.sourcePaths ?? []), ...(n.memberPaths ?? [])]) if (id) {
          positions.set(id, settled[i]!); sessionAnchors.set(id, anchor);
        }
      }
      held = { base, style, positions, sessionAnchors, overview: new Set(nodes.filter((_, i) => overview[i]).map(n => n.id)) };
    }
    // Hidden background nodes cannot crowd Pilots out of the visible graph.
    // Always reserve the overview and real context endpoints, plus other Pilots.
    const obstacles = new Set(held.overview);
    const pilots = new Set(graph.nodes.filter(n => n.layoutAnchors !== undefined).map(n => n.id));
    for (const e of graph.edges) {
      if (pilots.has(e.source)) obstacles.add(e.target);
      if (pilots.has(e.target)) obstacles.add(e.source);
    }
    const indices = new Map(graph.nodes.map((n, i) => [n.id, i]));
    const resolving = new Set<string>();
    const resolved = new Map<number, { x: number; y: number }>();
    const resolve = (i: number): { x: number; y: number } => {
      const cached = resolved.get(i);
      if (cached) return cached;
      const n = graph.nodes[i]!;
      const [x, y] = seedPosition(i);
      const fallback = { x: n.x ?? x, y: n.y ?? y };
      if (resolving.has(n.id)) return fallback; // Mention cycles need no layout cycle.
      resolving.add(n.id);
      const position = place(i);
      resolving.delete(n.id);
      resolved.set(i, position);
      return position;
    };
    const place = (i: number): { x: number; y: number } => {
      const n = graph.nodes[i]!;
      const settled = held!.positions.get(n.id);
      if (settled && n.layoutAnchors === undefined) return { ...settled };
      const anchors = (n.layoutAnchors ?? []).flatMap(id => {
        const index = indices.get(id);
        const p = held!.sessionAnchors.get(id) ?? (index !== undefined ? resolve(index) : undefined);
        return p ? [p] : [];
      });
      if (anchors.length) return {
        x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length + (n.layoutOffset?.x ?? 0),
        y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length + (n.layoutOffset?.y ?? 0),
      };
      if (n.layoutAnchors !== undefined) {
        // Context-free sessions share a bounded overview fallback; their array
        // index in a large vault must never determine their distance from it.
        const visible = [...held!.overview].map(id => held!.positions.get(id)!);
        return {
          x: (visible.length ? visible.reduce((sum, p) => sum + p.x, 0) / visible.length : 0) + (n.layoutOffset?.x ?? 0),
          y: (visible.length ? visible.reduce((sum, p) => sum + p.y, 0) / visible.length : 0) + (n.layoutOffset?.y ?? 0),
        };
      }
      const [x, y] = seedPosition(i);
      return { x: n.x ?? x, y: n.y ?? y };
    };
    return spaceSessions(graph.nodes, graph.nodes.map((_, i) => resolve(i)), obstacles);
  };
}
