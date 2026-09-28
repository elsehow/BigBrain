import { findNode, type GraphIdentity } from "./graphIdentity";

/** Portable view membership. IDs refer to the current graph; layout is separate. */
export interface GraphViewState {
  selected: string[];
  excluded: string[];
}

export type GraphViewAction =
  | { type: "select" | "add" | "exclude" | "restore"; id: string }
  | { type: "clear" };

/** Canonical order makes state independent of gesture order. Exclusions win. */
export function normalizeGraphView(state: GraphViewState): GraphViewState {
  const excluded = [...new Set(state.excluded)].sort();
  const removed = new Set(excluded);
  return { selected: [...new Set(state.selected)].filter(id => !removed.has(id)).sort(), excluded };
}

/** Routes and source aliases resolve to the same IDs used by graph gestures. */
export function canonicalGraphView(nodes: readonly GraphIdentity[], state: GraphViewState): GraphViewState {
  const resolve = (keys: string[]) => keys.map(key => nodes[findNode(nodes, key)]?.id ?? key);
  return normalizeGraphView({ selected: resolve(state.selected), excluded: resolve(state.excluded) });
}

export function changeGraphView(state: GraphViewState, action: GraphViewAction): GraphViewState {
  if (action.type === "clear") return { selected: [], excluded: [] };
  if (action.type === "select") return { selected: [action.id], excluded: [] };
  const selected = new Set(state.selected), excluded = new Set(state.excluded);
  if (action.type === "add") { selected.add(action.id); excluded.delete(action.id); }
  if (action.type === "exclude") { selected.delete(action.id); excluded.add(action.id); }
  if (action.type === "restore") excluded.delete(action.id);
  return normalizeGraphView({ selected: [...selected], excluded: [...excluded] });
}

export function graphViewAction(id: string, modifiers: { ctrlKey: boolean; shiftKey: boolean }): GraphViewAction {
  return { type: modifiers.ctrlKey ? "exclude" : modifiers.shiftKey ? "add" : "select", id };
}

/** Union of selected first-degree neighborhoods, with exclusions applied last.
 * An empty selection returns to the overview. Unknown IDs stay in the state
 * so a graph refresh can resolve them; they never become phantom nodes. */
export function resolveGraphView(ids: readonly string[], adjacency: readonly (readonly number[])[], state: GraphViewState, overview?: Uint8Array): {
  selected: Set<number>; excluded: Set<number>; visible: Set<number>;
} {
  const byId = new Map(ids.map((id, i) => [id, i]));
  const resolve = (keys: readonly string[]) => new Set(keys.flatMap(id => {
    const i = byId.get(id); return i === undefined ? [] : [i];
  }));
  const normalized = normalizeGraphView(state);
  const selected = resolve(normalized.selected), excluded = resolve(normalized.excluded);
  const visible = normalized.selected.length
    ? new Set([...selected].flatMap(i => [i, ...(adjacency[i] ?? [])]))
    : new Set(ids.flatMap((_, i) => !overview || overview[i] ? [i] : []));
  for (const i of excluded) visible.delete(i);
  return { selected, excluded, visible };
}
