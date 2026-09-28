import { findNode } from "../../../../lib/graphIdentity";
import type { GraphData, GraphNode } from "./types";

export const arrivals = $state<{ nodes: GraphNode[] }>({ nodes: [] });

export function recordArrival(path: string, title: string): void {
  arrivals.nodes = [...arrivals.nodes.filter(n => n.path !== path), {
    id: path, path, title, group: "source", degree: 0, pending: true,
  }];
}

/** Once observed in the real graph, an arrival must never be resurrected. */
export function reconcileArrivals(graph: GraphData): void {
  arrivals.nodes = arrivals.nodes.filter(n => findNode(graph.nodes, n.path ?? n.id) < 0);
}
