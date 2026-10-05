/**
 * contextSources.ts — what the sources in a Desktop's context concern (#119).
 *
 * Field stands a Desktop among the entities its context concerns, and a
 * source counts through the entities its claims mention. The primary graph
 * already holds exactly that: an edge from each source (or thread) to every
 * entity a live assertion citing it names, aliases folded and superseded
 * arrivals dropped (lib/assertionGraph.ts). So each source in a Desktop's
 * context is served with `entities`, its entity neighbours, whenever it was
 * read and whether or not the sorted feed kept it.
 *
 * A source with no filed claims yet has none: there is nothing in the field
 * to stand near until the gardener files it.
 */
import type { Graph, GraphNode } from "./graph";
import { graphIdentityIndex } from "./graphIdentity";

export interface ContextNode { id: string; path?: string; title?: string; group?: string; entities?: string[] }

interface SourceIndex { at: Map<string, number>; entities: Map<string, string[]> }
const indexes = new WeakMap<Graph, SourceIndex>();
/** Built once per graph: the cached graph is one object per vault revision. */
function sourceIndex(graph: Graph): SourceIndex {
  const held = indexes.get(graph);
  if (held) return held;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const entities = new Map<string, string[]>();
  for (const e of graph.edges) for (const [from, to] of [[e.source, e.target], [e.target, e.source]] as const) {
    if (byId.get(from)?.group !== "source" || !byId.get(to)?.entity) continue;
    const list = entities.get(from);
    if (list) list.push(to); else entities.set(from, [to]);
  }
  const index = { at: graphIdentityIndex(graph.nodes), entities };
  indexes.set(graph, index);
  return index;
}

/** A Desktop as Field places it: the context nodes it was given, plus every
 * source among its context ids, each source carrying the entities it
 * concerns. Anything else in its context is left as it was. */
export function withContextSources<D extends { context?: string[]; contextNodes?: ContextNode[] }>(desk: D, graph: Graph): D {
  const { at, entities } = sourceIndex(graph);
  const source = (ref: string | undefined): GraphNode | undefined => {
    const n = ref == null ? undefined : graph.nodes[at.get(ref) ?? -1];
    return n?.group === "source" ? n : undefined;
  };
  const given = (desk.contextNodes ?? []).map(n => {
    const s = source(n.id) ?? source(n.path);
    return s ? { ...n, entities: entities.get(s.id) ?? [] } : n;
  });
  const named = new Set(given.flatMap(n => [n.id, n.path]));
  const added = (desk.context ?? []).filter(ref => !named.has(ref)).flatMap(ref => {
    const s = source(ref);
    return s ? [{ id: ref, path: s.path ?? ref, title: s.title, group: "source", entities: entities.get(s.id) ?? [] }] : [];
  });
  if (!added.length && given.every((n, i) => n === desk.contextNodes![i])) return desk;
  return { ...desk, contextNodes: [...given, ...added] };
}

/** A list of Desktops as a route serves it: a graph that can't be read
 * leaves the sources unplaced, never the list unserved. */
export async function withContextSourcesOf<D extends { context?: string[]; contextNodes?: ContextNode[] }>(desks: D[], graph?: () => Promise<Graph>): Promise<D[]> {
  const g = await graph?.().catch(() => undefined);
  return g ? desks.map(d => withContextSources(d, g)) : desks;
}
