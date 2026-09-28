/**
 * graph.ts — the graph the viewer draws, as a type.
 *
 * It also HELD the note-link builder (extracted from web/server.ts so it was
 * importable and testable): nodes were notes under the view tree, edges
 * resolved wikilinks, with three hides (#317) over the top. That picture was
 * only ever drawn for a vault with no assertion events — lib/graphCache.ts's
 * primaryGraphCached prefers the assertion projection the moment one lands —
 * and a vault that new has nothing to draw either. It went on 2026-08-30;
 * lib/assertionGraph.ts builds the one graph now, and lib/links.ts still
 * enforces the same resolution rule for `bigbrain links check`.
 */

export interface GraphNode {
  /** Current provider state, independent of filing and agent activity. */
  readState?: import("./sourceReadStateTypes").SourceReadState;
  /** Original message paths represented by a source-thread node. */
  memberPaths?: string[];
  id: string;
  title: string;
  group: string;
  degree: number;
  /** Distinct memory backlinks, each discounted by the memory's breadth. */
  memorySupport?: number;
  x?: number;
  y?: number;
  /** Additive (phase 3) — present only on `kind: entity` notes. */
  entity?: true;
  entityType?: string;
  /** Explicit navigation target. Undefined means the legacy id itself;
   * null means a synthetic node has no note to open. */
  path?: string | null;
  /** Filed-by facet (additive): the arrival's provenance, the SAME fields
   * the feed's rows carry, so the viewer's one filedByLabel maps a node and
   * its row to the same filer. Only arrival nodes wear them — view-tree
   * notes and entities are nobody's filing. */
  band?: "person" | "agent" | "service" | "engine";
  via?: string;
  from?: string;
  /** Destination/detail of the arrival (for example the inbox address). */
  sourceDetail?: string;
  /** The arrival CHANNEL (frontmatter `source`) — nothing to do with an
   * edge's `source` endpoint. */
  source?: string;
  /** Additive: an arrival still WAITING for the gardener — landed, cited
   * by no assertion yet, not declined (lib/sourceFeed.ts's verdict, the
   * one the feed's spinner reads). It draws at degree 0, edgeless, and
   * the viewer turns it (LinkGraph's spinner) until the round that files
   * it gives it its threads, or a decline takes it off the picture. Only
   * source nodes wear it. */
  pending?: true;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Additive: how many assertions put these two together. Absent means
   * once. The viewer draws a heavier pair as a brighter thread
   * (LinkGraph.svelte); the layout does not read it. */
  weight?: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hash: string;
  projection?: "assertions";
  /** Trusted owner identity, omitted from graph nodes and inline navigation. */
  userNote?: { ids: string[]; names: string[] };
}
