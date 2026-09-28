import { aggregateReadState, type SourceReadState } from "../../../../lib/sourceReadStateTypes";
import type { GraphIdentity } from "../../../../lib/graphIdentity";

/** Search and recents may use a thread's older path or an individual member.
 * Prefer fresh per-source observations, then resolve the graph's aliases. */
export function sourceReadIndex(
  nodes: readonly (GraphIdentity & { readState?: SourceReadState })[],
  rows: readonly { path: string; readState: SourceReadState }[],
): Map<string, SourceReadState> {
  const index = new Map(rows.map(row => [row.path, row.readState]));
  for (const node of nodes) {
    const aliases = [...(node.memberPaths ?? []), ...(node.sourcePaths ?? [])];
    const members = aliases.map(path => index.get(path)).filter((state): state is SourceReadState => !!state);
    const state = index.get(node.path ?? node.id) ?? (members.length ? aggregateReadState(members) : node.readState);
    if (!state) continue;
    for (const path of [node.id, node.path, ...aliases]) if (path && !index.has(path)) index.set(path, state);
  }
  return index;
}
