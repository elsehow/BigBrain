/** graphDelta.ts — what changed between two pictures of the field
 * (docs/plans/2026-10-11-field-of-assertions.md, step 8). A commit touches a
 * few assertions, and each assertion draws a fixed set of nodes and edges,
 * whose seats never move what was seated before them (lib/views/layout.ts):
 * so a viewer that holds the last picture needs only what changed, not the
 * whole field again. Pure, and safe for the browser bundle: the viewer
 * applies what the server diffs.
 */
import type { Graph, GraphEdge, GraphNode } from "../graph";

export interface GraphDelta {
  /** The stamps (ETags) of the picture it applies to and the one it makes:
   * what a viewer holds and asks with. */
  from: string;
  to: string;
  /** The same two pictures' structure hashes (Graph.hash). */
  base: string;
  hash: string;
  /** Nodes added or changed, whole; ids of nodes removed. */
  nodes: GraphNode[];
  removed: string[];
  /** Edges added or changed, whole; edges removed, as [source, target]. */
  edges: GraphEdge[];
  unedged: [string, string][];
  /** The picture's own fields, as the new one has them. */
  userNote?: Graph["userNote"];
}

const edgeKey = (e: { source: string; target: string }) => `${e.source}\u0000${e.target}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byEnds = (a: GraphEdge, b: GraphEdge) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0);

/** What turns `from` into `to`, the pictures served under the stamps given. */
export function diffGraph(from: Graph, to: Graph, stamps: { from: string; to: string } = { from: from.hash, to: to.hash }): GraphDelta {
  const was = new Map(from.nodes.map((n) => [n.id, n])), now = new Map(to.nodes.map((n) => [n.id, n]));
  const wasEdges = new Map(from.edges.map((e) => [edgeKey(e), e])), nowEdges = new Map(to.edges.map((e) => [edgeKey(e), e]));
  return {
    ...stamps, base: from.hash, hash: to.hash,
    nodes: to.nodes.filter((n) => !same(was.get(n.id), n)),
    removed: from.nodes.filter((n) => !now.has(n.id)).map((n) => n.id),
    edges: to.edges.filter((e) => !same(wasEdges.get(edgeKey(e)), e)),
    unedged: from.edges.filter((e) => !nowEdges.has(edgeKey(e))).map((e) => [e.source, e.target]),
    ...(to.userNote ? { userNote: to.userNote } : {}),
  };
}

/** `from` with `delta` applied: the picture the server drew, in its order
 * (nodes by id, edges by their ends). */
export function applyGraphDelta(from: Graph, delta: GraphDelta): Graph {
  if (from.hash !== delta.base) throw new Error("graph delta: not the picture it applies to");
  const nodes = new Map(from.nodes.map((n) => [n.id, n]));
  for (const id of delta.removed) nodes.delete(id);
  for (const n of delta.nodes) nodes.set(n.id, n);
  const edges = new Map(from.edges.map((e) => [edgeKey(e), e]));
  for (const [source, target] of delta.unedged) edges.delete(edgeKey({ source, target }));
  for (const e of delta.edges) edges.set(edgeKey(e), e);
  const { userNote: _was, ...rest } = from;
  return { ...rest, nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort(byEnds), hash: delta.hash,
    ...(delta.userNote ? { userNote: delta.userNote } : {}) };
}
