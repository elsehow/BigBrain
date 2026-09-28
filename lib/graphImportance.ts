import { findNode, type GraphIdentity } from "./graphIdentity";

/** Overview salience for depth, visual hierarchy, and general navigation.
 * Briefing candidates instead use the selection-relative scores below.
 * Timestamps and assertion order play no role. */
export const MAX_IMPORTANCE = 1.12;
export const FOREGROUND_IMPORTANCE = 0.72;
const LIVE_IMPORTANCE = 1.6;

export function importanceScores(adjacency: readonly (readonly number[])[], memory: readonly boolean[] = [], live: ArrayLike<number> = [], memorySupport: ArrayLike<number> = []): Float32Array {
  const degree = adjacency.map((js, i) => new Set(js.filter(j => j !== i)).size);
  const maximum = Math.log1p(degree.reduce((m, d) => Math.max(m, d), 1));
  // Quantized tiers make memory support primary and connectivity a true tie
  // breaker. Retain the old scale when no memory backlinks are available.
  const support = degree.map((_, i) => Math.round((memorySupport[i] ?? 0) * 1e9));
  const levels = [...new Set(support.filter(n => n > 0))].sort((a, b) => a - b);
  const ranks = new Map(levels.map((n, i) => [n, i + 1]));
  return Float32Array.from(degree, (d, i) => {
    if (live[i]) return LIVE_IMPORTANCE;
    if (memory[i]) return MAX_IMPORTANCE;
    const global = Math.log1p(d) / maximum;
    // Local hubs matter even in small components; isolates remain discoverable.
    const localMax = adjacency[i]!.reduce((m, j) => Math.max(m, degree[j]!), d);
    const local = d >= 2 ? d / Math.max(1, localMax) : d === 0 ? 0.4 : 0.12;
    const connected = Math.max(global, local * 0.8);
    if (!levels.length) return connected;
    const rank = ranks.get(support[i]!);
    return rank === undefined ? connected * 0.68
      : FOREGROUND_IMPORTANCE + 0.28 * (rank + connected * 0.5) / (levels.length + 1);
  });
}

/** Live work stays forward even outside the selected neighbourhood. Its
 * exceptional prominence is part of salience, not a renderer-only override. */
export const isLiveImportance = (score: number): boolean => score > MAX_IMPORTANCE + 0.01;
export const importanceFloor = (score: number): number => isLiveImportance(score) ? 72 : -Infinity;

export interface ImportanceGraph {
  nodes: readonly (GraphIdentity & { group: string; live?: string; memorySupport?: number })[];
  edges: readonly { source: string; target: string }[];
}
export function graphImportance(graph: ImportanceGraph): { adjacency: number[][]; scores: Float32Array } {
  const byId = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const sets = graph.nodes.map(() => new Set<number>());
  for (const e of graph.edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    sets[a]!.add(b); sets[b]!.add(a);
  }
  const adjacency = sets.map(s => [...s]);
  return { adjacency, scores: importanceScores(adjacency, graph.nodes.map(n => n.group === "memory"), Uint8Array.from(graph.nodes, n => n.live ? 1 : 0), graph.nodes.map(n => n.memorySupport ?? 0)) };
}

/** Random walks restart uniformly at the selected anchors with probability
 * 0.3 (about 2.3 edges between restarts). Dangling mass returns to those seeds.
 * Deterministic iteration, bounded to 64 passes; no model calls or edge weights.
 * Input adjacency is the same undirected, deduplicated topology as the viewer. */
export function personalizedPageRank(adjacency: readonly (readonly number[])[], seeds: readonly number[]): Float64Array {
  const selected = [...new Set(seeds)].filter(i => Number.isInteger(i) && i >= 0 && i < adjacency.length);
  let scores = new Float64Array(adjacency.length);
  if (!selected.length) return scores;
  for (const i of selected) scores[i] = 1 / selected.length;
  for (let iteration = 0; iteration < 64; iteration++) {
    const next = new Float64Array(adjacency.length);
    let restart = 0.3;
    for (let i = 0; i < adjacency.length; i++) {
      const neighbors = adjacency[i]!;
      if (!neighbors.length) { restart += 0.7 * scores[i]!; continue; }
      const share = 0.7 * scores[i]! / neighbors.length;
      for (const j of neighbors) next[j] = next[j]! + share;
    }
    for (const i of selected) next[i] = next[i]! + restart / selected.length;
    let change = 0;
    for (let i = 0; i < next.length; i++) change += Math.abs(next[i]! - scores[i]!);
    scores = next;
    if (change < 1e-9) break;
  }
  return scores;
}

export type ConnectionRanking = "importance" | "personalized" | "normalized" | "discounted";
// A full division by degree overpromotes rare leaves in the vault graph.
// A fourth-root discount keeps local hubs while reducing global hub bias.
export const BRIEFING_DEGREE_DISCOUNT = 0.25;

export function briefingConnections<T extends ImportanceGraph>(graph: T, keys: readonly string[], excluded: readonly string[] = []) {
  return selectionConnections(graph, keys, excluded, "discounted");
}

/** Stable ties are by node identity, so reordering ingestion or graph payloads
 * never shuffles a connection walk. Every result is exactly one hop away. */
export function importantConnections<T extends ImportanceGraph>(graph: T, key: string): T["nodes"][number][] {
  return selectionConnections(graph, [key]).map(link => link.node);
}

/** Shared neighbors first, then the chosen salience policy. Each neighbor
 * appears once and records precisely which selected anchors connect to it. */
export function selectionConnections<T extends ImportanceGraph>(graph: T, keys: readonly string[], excluded: readonly string[] = [], ranking: ConnectionRanking = "importance"): Array<{ node: T["nodes"][number]; selected: string[] }> {
  const selected = new Set(keys.map(key => findNode(graph.nodes, key)).filter(i => i >= 0));
  const removed = new Set(excluded.map(key => findNode(graph.nodes, key)));
  for (const i of removed) selected.delete(i);
  if (!selected.size) return [];
  const { adjacency, scores } = graphImportance(graph);
  const walk = ranking === "importance" ? undefined : adjacency.map((neighbors, i) => removed.has(i) ? [] : neighbors.filter(j => !removed.has(j)));
  const personal = walk ? personalizedPageRank(walk, [...selected]) : undefined;
  const discount = ranking === "normalized" ? 1 : ranking === "discounted" ? BRIEFING_DEGREE_DISCOUNT : 0;
  const relevance = personal ? Array.from(personal, (score, i) => score / Math.pow(Math.max(1, walk![i]!.length), discount)) : scores;
  const neighbors = new Map<number, string[]>();
  for (const i of selected) for (const j of adjacency[i]!) {
    if (selected.has(j) || removed.has(j)) continue;
    const anchors = neighbors.get(j) ?? [];
    anchors.push(graph.nodes[i]!.id);
    neighbors.set(j, anchors);
  }
  return [...neighbors].sort(([a, as], [b, bs]) => bs.length - as.length ||
    Math.round(relevance[b]! * 1e12) - Math.round(relevance[a]! * 1e12) ||
    (graph.nodes[a]!.id < graph.nodes[b]!.id ? -1 : 1)).map(([i, anchors]) => ({ node: graph.nodes[i]!, selected: anchors.sort() }));
}
