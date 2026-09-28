import type { GraphData, GraphNode } from '../types';
import type { PilotVisualPhase } from '../pilotAppearance';

// Shared with the shader: zero is an ordinary node, 8-10 are the legacy
// activity rings, so a new phase takes a free code rather than the next index.
const phases: Record<PilotVisualPhase, number> = { idle: 1, active: 2, draft: 3, working: 4, interrupted: 5, failed: 6, answered: 7, unknown: 11 };
export const phaseCode = (node: GraphNode) => node.pilotPhase ? phases[node.pilotPhase] : node.pending ? 8 : node.live === 'working' ? 9 : node.live === 'waiting' ? 10 : 0;
export const needsAttention = (node: GraphNode) => node.pilotPhase ? !!node.pilotNeedsYou : node.group === 'source' && node.readState?.unread === true;
export const animatedStatus = (node: GraphNode) => needsAttention(node) || node.pilotPhase === 'draft' || node.pilotPhase === 'working' || !node.pilotPhase && (!!node.pending || !!node.live);

/** Status/title updates must not recreate buffers, reset focus or rerun layout.
 * Presence of an agent still matters, since it changes geometry and placement. */
export function graphGeometryKey(graph: GraphData): string {
  return JSON.stringify([graph.nodes.map(n => ({ ...n, title: undefined, readState: undefined,
    agentState: undefined, pilotPhase: !!n.pilotPhase, pilotNeedsYou: undefined, pilotDraft: undefined,
    pilotActive: undefined, pilotContext: undefined, live: undefined, pending: undefined, group: n.pilotPhase && n.group !== 'agent' ? 'pilot' : n.group })), graph.edges.map(e => ({ ...e, pilotContext: undefined }))]);
}
