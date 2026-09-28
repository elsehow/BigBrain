import type { Graph } from "./graph";
import { graphIdentityIndex } from "./graphIdentity";
import type { PilotChatSession } from "./pilotChatTypes";

/** Versioned independently of Quick settings: these scores make no model calls. */
export const PILOT_CATEGORY_GRAPH_VERSION = "graph-neighborhood-v1";
export type CategorySession = Pick<PilotChatSession, "id" | "context" | "ingestions">;
export interface CategoryRanking {
  memories: Array<{ id: string; path?: string | null; title: string }>;
  anchors: string[];
  ranking: Array<{ memory: string; title: string; score: number }>;
  winners: string[];
}

/** Rank memories by their existing entity neighborhoods, not visits to memory
 * nodes. Source breadth discounts incidental links in large transcripts. Degree
 * correction measures excess visitation over the background random walk.
 * Scores are NOT probabilities. No prose, stored affiliations or semantic edges.
 * A conversation's own captured sources cannot endorse its placement. */
export function rankPilotCategories(graph: Graph, session: CategorySession): CategoryRanking {
  const own = new Set([session.id, ...(session.ingestions ?? []).flatMap(i => [i.path, i.sourceId, `source:${i.insertionId}`])]);
  const nodes = graph.nodes.filter(n => !own.has(n.id) && !own.has(n.path ?? "")
    && (n as typeof n & { sessionId?: string }).sessionId !== session.id
    && !(n.memberPaths ?? []).some(p => own.has(p)) && !/(^|\/)MEMORY\.md$/.test(n.path ?? n.id));
  const ids = new Map(nodes.map((n, i) => [n.id, i])), aliases = graphIdentityIndex(nodes);
  const maps = nodes.map(() => new Map<number, number>());
  for (const edge of graph.edges) {
    const a = ids.get(edge.source), b = ids.get(edge.target), weight = edge.weight ?? 1;
    if (a === undefined || b === undefined || a === b || !Number.isFinite(weight) || weight <= 0) continue;
    // The graph is a pair projection; duplicate pairs aren't new evidence.
    maps[a]!.set(b, Math.max(maps[a]!.get(b) ?? 0, weight));
    maps[b]!.set(a, Math.max(maps[b]!.get(a) ?? 0, weight));
  }
  const memories = nodes.flatMap((n, i) => n.group === "memory" ? [i] : []);
  const neighborhoods = memories.map(i => [...maps[i]!.keys()].filter(j => nodes[j]!.group === "entity"));
  const selected = [...new Set(session.context.flatMap(key => aliases.has(key) ? [aliases.get(key)!] : []))];
  const anchors = selected.map(i => nodes[i]!.id);
  const seeds = [...new Set(selected.flatMap(i => nodes[i]!.group === "memory"
    ? [...maps[i]!.keys()].filter(j => nodes[j]!.group === "entity") : [i]))];
  const result: CategoryRanking = { memories: memories.map(i => nodes[i]!), anchors, ranking: [], winners: [] };
  if (!seeds.length || !memories.length) return result;

  // Measure source breadth before removing memory transit edges, as in the
  // offline neighborhood/source-breadth experiment.
  const breadth = nodes.map((n, i) => n.group === "source" ? Math.max(1, maps[i]!.size - 1) : 1);
  const adjacency = maps.map((neighbors, i) => nodes[i]!.group === "memory" ? [] : [...neighbors]
    .filter(([j]) => nodes[j]!.group !== "memory")
    .map(([to, count]) => ({ to, weight: Math.log1p(count) / Math.sqrt(breadth[i]! * breadth[to]!) })));
  const strength = adjacency.map(edges => edges.reduce((sum, e) => sum + e.weight, 0));
  let scores = new Float64Array(nodes.length);
  for (const seed of seeds) scores[seed] = 1 / seeds.length;
  for (let iteration = 0; iteration < 300; iteration++) {
    const next = new Float64Array(nodes.length); let teleport = 0.15;
    for (let i = 0; i < nodes.length; i++) {
      if (!strength[i]) { teleport += 0.85 * scores[i]!; continue; }
      const share = 0.85 * scores[i]! / strength[i]!;
      for (const e of adjacency[i]!) next[e.to] = next[e.to]! + share * e.weight;
    }
    for (const seed of seeds) next[seed] = next[seed]! + teleport / seeds.length;
    let change = 0;
    for (let i = 0; i < nodes.length; i++) change += Math.abs(next[i]! - scores[i]!);
    scores = next;
    if (change < 1e-11) break;
  }
  result.ranking = memories.map((m, i) => ({ memory: nodes[m]!.id, title: nodes[m]!.title,
    score: neighborhoods[i]!.length ? neighborhoods[i]!.reduce((sum, j) => sum + scores[j]! / (strength[j] || 1), 0) / neighborhoods[i]!.length : 0,
  })).filter(r => Number.isFinite(r.score) && r.score > 0)
    .sort((a, b) => b.score - a.score || a.memory.localeCompare(b.memory));
  const best = result.ranking[0]?.score ?? 0;
  result.winners = result.ranking.filter(r => Math.abs(r.score - best) <= Math.max(1e-15, best * 1e-9)).map(r => r.memory);
  return result;
}
