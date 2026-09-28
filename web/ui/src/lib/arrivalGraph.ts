import { findNode } from "../../../../lib/graphIdentity";
import type { GraphData, GraphNode } from "./types";

/** Receipt-backed arrivals fill the gap before the graph refresh catches up. */
export function withArrivals(graph: GraphData | null, arrivals: GraphNode[]): GraphData | null {
  const missing = arrivals.filter(n => findNode(graph?.nodes ?? [], n.path ?? n.id) < 0);
  if (!missing.length) return graph;
  return {
    ...graph,
    layoutBase: graph?.layoutBase ?? graph ?? undefined,
    nodes: [...(graph?.nodes ?? []), ...missing],
    edges: graph?.edges ?? [],
    hash: `${graph?.hash ?? ""}:arrivals:${missing.map(n => n.id).join(",")}`,
  };
}
