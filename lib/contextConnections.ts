import { graphIdentityIndex } from "./graphIdentity";
import { briefingConnections, type ImportanceGraph } from "./graphImportance";

/** One context-local order for mentions, displayed links and Quick's prompt.
 * Explicit memory references, then summed connection strength, then local relevance and stable ID ties.
 * Never uses global popularity, live agent status or ingestion order. */
export function contextConnections<T extends ImportanceGraph>(graph: T, keys: readonly string[], excluded: readonly string[] = [], bodies: Record<string, string> = {}): Array<{ node: T["nodes"][number]; selected: string[]; explicit: boolean }> {
  const index = graphIdentityIndex(graph.nodes);
  const anchors = new Set(keys.flatMap(key => index.has(key) ? [index.get(key)!] : []));
  const removed = new Set(excluded.map(key => index.get(key)));
  for (const i of removed) if (i !== undefined) anchors.delete(i);
  const scores = new Map<number, { explicit: boolean; weight: number; selected: Set<string> }>();
  for (const anchor of anchors) {
    const node = graph.nodes[anchor]!;
    const mentioned = new Set<number>();
    if (node.group === "memory") for (const match of (bodies[node.id] ?? bodies[node.path ?? ""] ?? "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      const path = match[1]!.split("#")[0]!;
      const i = index.get(path) ?? index.get(`${path}.md`);
      if (i !== undefined) mentioned.add(i);
    }
    const add = (i: number, weight: number) => {
      const target = graph.nodes[i]!;
      if (anchors.has(i) || removed.has(i) || !target.path || target.group === "pilot" || target.group === "session") return;
      const score = scores.get(i) ?? { explicit: false, weight: 0, selected: new Set<string>() };
      score.explicit ||= mentioned.has(i); score.weight += weight; score.selected.add(node.id); scores.set(i, score);
    };
    const connected = new Set<number>();
    for (const edge of graph.edges) {
      const a = index.get(edge.source), b = index.get(edge.target);
      const other = a === anchor ? b : b === anchor ? a : undefined;
      if (other !== undefined) { add(other, (edge as { weight?: number }).weight ?? 1); connected.add(other); }
    }
    for (const i of mentioned) if (!connected.has(i)) add(i, 1);
  }
  const persistentNodes = graph.nodes.filter(n => n.group !== "pilot" && n.group !== "session");
  const persistentIds = new Set(persistentNodes.map(n => n.id));
  const persistentGraph = { ...graph, nodes: persistentNodes, edges: graph.edges.filter(e => persistentIds.has(e.source) && persistentIds.has(e.target)) };
  const localRank = new Map(briefingConnections(persistentGraph, keys, excluded).map(({ node }, i) => [node.id, i]));
  return [...scores].sort(([a, x], [b, y]) => Number(y.explicit) - Number(x.explicit) || y.weight - x.weight || (localRank.get(graph.nodes[a]!.id) ?? Infinity) - (localRank.get(graph.nodes[b]!.id) ?? Infinity) || graph.nodes[a]!.id.localeCompare(graph.nodes[b]!.id))
    .map(([i, score]) => ({ node: graph.nodes[i]!, selected: [...score.selected].sort(), explicit: score.explicit }));
}
