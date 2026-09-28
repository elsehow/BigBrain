import type { WorkSummary } from "../../../../lib/workViews";
import { sessionPath } from "../../../../lib/workSessionIdentity";
import { agentVisualState } from "./agentAppearance";
import { inSessionOrder } from "./sessionOrder";
import type { GraphData } from "./types";

export function withAgentOrchestrator(graph: GraphData | null, sessions: WorkSummary[]): GraphData | null {
  if (!graph) return graph;
  // The live list is sorted by recency, so a worker reporting progress overtakes
  // its siblings. Draw them in creation order instead: a report is not new
  // geometry, and reordering these nodes would rebuild the renderer.
  const agents = inSessionOrder(sessions.filter(s => s.worker || s.external));
  if (!agents.length) return graph;
  const nodes = [...graph.nodes], edges = [...graph.edges];
  for (const s of agents) {
    const state = agentVisualState(s), path = sessionPath(s.id);
    const anchors = s.origin?.pilot ? [s.origin.pilot] : [];
    const parent = graph.nodes.find(n => n.id === s.origin?.pilot);
    nodes.push({ id: s.id, path, sourcePaths: [path], title: s.title, group: "agent", degree: anchors.length,
      from: s.provider, sessionId: s.thread, agentState: state,
      pilotPhase: state === "running" ? "working" : state === "stopped" ? "idle" : "active", pilotNeedsYou: state === "waiting",
      live: state === "running" ? "working" : state === "waiting" ? "waiting" : undefined,
      layoutAnchors: anchors, layoutOffset: { x: 65, y: 45 }, x: (parent?.x ?? 0) + 65, y: (parent?.y ?? 0) + 45 });
    for (const id of anchors) {
      const n = graph.nodes.find(n => n.id === id || n.path === id);
      if (n) edges.push({ source: n.id, target: s.id, pilotContext: true });
    }
  }
  return { ...graph, layoutBase: graph.layoutBase ?? graph, nodes, edges, hash: `${graph.hash}:external:${agents.map(s => s.id).join(",")}` };
}
