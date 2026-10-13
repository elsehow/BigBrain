/** The whole field's graph for a vault root: the graph view
 * (lib/views/graph.ts) over everything live, for callers that hold a root
 * rather than a snapshot. */
import type { Graph } from "./graph";
import type { ObserveConnection } from "./markdownGraph";
import { vaultRecord, type VaultRecord } from "./vaultReadModel";
import { drawGraph } from "./views/graph";
import { liveOf } from "./views/scope";

export function buildAssertionGraph(root: string, observe?: ObserveConnection, record: VaultRecord = vaultRecord(root)): Graph {
  return drawGraph(record, liveOf(record), observe);
}
