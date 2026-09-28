import { aggregateReadState, type SourceReadState } from '../../../../lib/sourceReadStateTypes';
import type { SourceReadStateRow } from '../../../../lib/sourceReadState';
import type { GraphData } from './types';

/** Threads reflect every known member, not just the representative source. */
export function withSourceReadStates(graph: GraphData | null, rows: SourceReadStateRow[]): GraphData | null {
  if (!graph) return null;
  const byPath = new Map(rows.map(r => [r.path, r.readState]));
  const unknown: SourceReadState = { unread: null, writable: false, status: 'unknown' };
  return { ...graph, layoutBase: graph.layoutBase ?? graph, nodes: graph.nodes.map(n => {
    const paths = [...new Set([n.path, ...(n.memberPaths ?? []), ...(n.sourcePaths ?? [])].filter((p): p is string => !!p && p.startsWith('log/insertions/')))];
    if (!paths.length || !paths.some(p => byPath.has(p))) return n;
    return { ...n, readState: aggregateReadState(paths.map(p => byPath.get(p) ?? unknown)) };
  }) };
}
