import { canonicalGraphView, resolveGraphView, type GraphViewState } from '../../../../../lib/graphView';
import { findNode } from '../../../../../lib/graphIdentity';
import type { GraphNode } from '../types';

/** One interpretation of portable membership for rendering, gestures and previews. */
export function graphView(nodes: readonly GraphNode[], adjacency: readonly (readonly number[])[], view: GraphViewState, focus: string | null) {
  const canonical = canonicalGraphView(nodes, view);
  const resolved = resolveGraphView(nodes.map(n => n.id), adjacency, canonical);
  const requested = focus ? findNode(nodes, focus) : -1;
  const anchor = requested >= 0 && !resolved.excluded.has(requested) ? requested : resolved.selected.values().next().value ?? -1;
  return { ...resolved, view: canonical, anchor };
}
