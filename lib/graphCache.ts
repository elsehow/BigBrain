import { background } from "./readModelBackground";
/**
 * graphCache.ts — the graph routes' state, extracted from web/server.ts
 * (#260 seam list): the revision-keyed build memo, and the settled layout in
 * .state/, keyed by the structure hash.
 *
 * The layout used to be computed in the browser and POSTed back here. That
 * upload was refused by the read-only gate on every hosted vault and dropped
 * silently, so no vault ever held one and every page load re-simulated. Now
 * the layout is produced HERE (lib/graphLayout.ts) from the graph this module
 * already builds — a layout is a pure function of the structure, so it
 * belongs on the side that owns the structure. See lib/graphLayout.ts.
 */

import type { ConnectionEvidence } from "./markdownGraph";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Graph } from "./graph";
import { computeLayout, type Positions } from "./graphLayout";
import { buildAssertionGraph } from "./assertionGraph";
import { vaultRecord, invalidateVaultReadModel, currentReadRevision, withVaultSnapshot, vaultReconciliationDue, readModelRevision, acceptReadModelRevision } from "./vaultReadModel";
export { readModelRevision } from "./vaultReadModel";
import { vaultChangeVersion } from "./vaultChanges";

/** One projection is left — the assertion graph. The link graph it replaced
 * had its own layout file, and the name is kept so a vault's settled layout
 * survives this deletion rather than re-simulating once. */
export type Projection = "assertions";
export type LayoutCache = { hash: string; positions: Positions };

const layoutPath = (root: string, projection: Projection): string =>
  join(root, ".state", `graph-layout-${projection}.json`);

export function readLayoutCache(root: string, projection: Projection = "assertions"): LayoutCache | null {
  try {
    return JSON.parse(readFileSync(layoutPath(root, projection), "utf8")) as LayoutCache;
  } catch {
    return null;
  }
}

/** Exactly ONE entry per projection, overwritten. Keyed by hash but not
 * ACCUMULATED by hash: a busy vault turns its structure over ~15-20 times a
 * day, so keeping every layout ever computed would grow without bound for no
 * gain — a superseded structure is never asked for again. */
function writeLayout(root: string, projection: Projection, layout: LayoutCache): void {
  try {
    mkdirSync(dirname(layoutPath(root, projection)), { recursive: true });
    writeFileSync(layoutPath(root, projection), JSON.stringify(layout));
  } catch {
    // .state is a regenerable render cache and the vault may be read-only (a
    // pilot clone, a bench fixture). Failing to persist costs a re-simulation
    // next time; failing the REQUEST would cost the graph entirely.
  }
}

function bake(nodes: { id: string; x?: number; y?: number }[], positions: Positions): void {
  for (const n of nodes) {
    const pos = positions[n.id];
    if (pos) {
      n.x = pos[0];
      n.y = pos[1];
    }
  }
}

/**
 * The graph a viewer should draw: structure plus settled positions.
 *
 * Cache hit (the overwhelmingly common case — a vault's link structure is
 * stable for hours at a time) costs one JSON read. A miss simulates once and
 * persists, so the NEXT reader of that structure is free, on this device and
 * every other. Nodes are mutated in place on the memoized graph, so repeated
 * hits within the memo window do not re-read the file either.
 */
export function graphWithLayout(root: string, graph: Graph): Graph {
  const projection: Projection = "assertions";
  const cache = readLayoutCache(root, projection);
  if (cache?.hash === graph.hash) {
    bake(graph.nodes, cache.positions);
    return graph;
  }
  // Seed from the superseded layout: surviving nodes start where they already
  // are, so a structure change reads as the graph MOVING rather than a
  // different graph appearing, identically for every viewer.
  const positions = computeLayout(graph, cache?.positions);
  writeLayout(root, projection, { hash: graph.hash, positions });
  bake(graph.nodes, positions);
  return graph;
}

export interface GraphWithEvidence {
  revision: string;
  graph: ReturnType<typeof buildAssertionGraph>;
  connections: Array<{ from: string; to: string; evidence: ConnectionEvidence }>;
}
const assertionMemo = new Map<string, GraphWithEvidence>();

export function assertionGraphEvidenceCached(root: string): GraphWithEvidence {
  return withVaultSnapshot(root, (_db, revision) => {
    const held = assertionMemo.get(root);
    if (held?.revision === revision) return held;
    const record = vaultRecord(root);
    const connections: GraphWithEvidence["connections"] = [];
    const graph = buildAssertionGraph(root, (from, to, evidence) => connections.push({ from, to, evidence }), record);
    const result = { revision, graph, connections };
    assertionMemo.set(root, result);
    return result;
  });
}

export function assertionGraphCached(root: string): ReturnType<typeof buildAssertionGraph> {
  return assertionGraphEvidenceCached(root).graph;
}

/** The vault's one graph: the assertion projection. A vault with no
 * assertions yet draws nothing — the markdown link graph that used to
 * stand in for it went on 2026-08-30, and a vault that new has no
 * entities/ to draw either. */
export function primaryGraphCached(root: string): Graph {
  const assertions = assertionGraphCached(root);
  return assertions.nodes.length ? assertions : EMPTY_GRAPH;
}

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [], hash: "empty", projection: "assertions" };

/** Invalidate shared freshness and reject workers started before this hint. */
export function invalidateGraphCaches(root: string): void {
  invalidateVaultReadModel(root);
  assertionMemo.delete(root);
  generations.set(root, (generations.get(root) ?? 0) + 1);
}

// The synchronous reader remains available to command-line callers. Viewer
// requests and live warming share one in-flight background build per vault.
// Workers terminate after each job, retaining no second vault copy while idle.
const generations = new Map<string, number>();
const builds = new Map<string, Promise<void>>();
export type GraphSnapshot = GraphWithEvidence | { revision: string };

export async function assertionGraphEvidenceAsync(root: string): Promise<GraphWithEvidence> {
  // Resolve inside an already borrowed transaction before returning a promise.
  if (currentReadRevision(root)) return assertionGraphEvidenceCached(root);
  for (;;) {
    const held = assertionMemo.get(root);
    if (!vaultReconciliationDue(root) && held?.revision === readModelRevision(root)) return held;
    let pending = builds.get(root);
    if (!pending) {
      const generation = generations.get(root) ?? 0, change = vaultChangeVersion(root);
      pending = background<GraphSnapshot>({ kind: "graph", root, knownRevision: held?.revision }).then(result => {
        const prepared = "graph" in result ? result : assertionMemo.get(root);
        // Reuse an unchanged graph after the worker's census. A stale worker
        // may neither publish a graph nor satisfy the shared freshness clock.
        if (generation !== (generations.get(root) ?? 0) || prepared?.revision !== result.revision
          || !acceptReadModelRevision(root, result.revision, change)) return;
        assertionMemo.set(root, prepared);
      }).finally(() => builds.delete(root));
      builds.set(root, pending);
    }
    await pending;
  }
}

