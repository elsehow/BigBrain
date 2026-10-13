/**
 * graphCache.ts — the empty graph, and the projection's revision for the
 * graph's readers. The graph is a view its maintainer keeps
 * (lib/maintainedGraph.ts), seated as a view too (lib/views/layout.ts).
 *
 * This held the graph's settled layout in `.state/`, keyed by structure and
 * grown from the layout before it, so the picture depended on the order its
 * changes had arrived in on this machine. The view is cached by revision
 * instead (R7, docs/plans/2026-10-12-stages-and-views-refactor.md), and the
 * old file is left for `.state/` to shed.
 */
import type { Graph } from "./graph";
export { readModelRevision } from "./vaultReadModel";

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [], hash: "empty", projection: "assertions" };
