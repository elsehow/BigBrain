import type { GraphNode } from './types';
import { activeContextPilot } from './graphPilotContext';

type OverviewNode = Pick<GraphNode, 'pilotActive' | 'pilotPhase' | 'pilotNeedsYou' | 'live' | 'memorySupport' | 'group'> & { unread?: boolean };
type ContextEdge = { a: number; b: number; pilotContext?: boolean };

/** Active conversations stay on the overview between turns. Dormant sessions
 * still need memory evidence; saved context alone does not revive them. */
export function applyOverviewAttention(nodes: readonly OverviewNode[], visible: Set<number>, excluded: ReadonlySet<number>, unreadAttention: boolean, edges: readonly ContextEdge[] = []): void {
  const active = new Set<number>();
  nodes.forEach((node, i) => {
    if (excluded.has(i)) return;
    if (node.pilotPhase) {
      if (activeContextPilot(node)) {
        visible.add(i); active.add(i);
      } else if (!(node.memorySupport && node.memorySupport > 0)) visible.delete(i);
    } else if (unreadAttention && node.unread && node.group === 'source') visible.add(i);
  });
  // Reveal actual context endpoints so their existing edges can draw. Do not
  // expand arbitrary neighbors or recursively wake historical conversations.
  for (const e of edges) {
    if (!e.pilotContext) continue;
    if (active.has(e.a) && !excluded.has(e.b)) visible.add(e.b);
    if (active.has(e.b) && !excluded.has(e.a)) visible.add(e.a);
  }
}
