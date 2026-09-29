import type { PilotViewData } from "./pilotChatSync";
import { pilotRoster } from "./pilotAttention";
import { inSessionOrder } from "./sessionOrder";
import { pilotVisualPhase } from "./pilotAppearance";
import { belongsToSession, sessionPath } from "../../../../lib/workSessionIdentity";
import type { GraphData, GraphNode } from "./types";

/** Coalesce ingested chapters into the original session node. Its current
 * context remains independent of historical source associations. */
export function withPilotChats(graph: GraphData | null, sessions: PilotViewData[], activeId: string | null, drafts: Record<string, string> = {}): GraphData | null {
  return preparePilotChats(graph, sessions, drafts)(activeId);
}

/** Prepare coalescing and context links once per graph/session update. Selection
 * only applies styling and visibility to that immutable overlay. */
export function preparePilotChats(graph: GraphData | null, sessions: PilotViewData[], drafts: Record<string, string> = {}): (activeId: string | null) => GraphData | null {
  if (!sessions.length) return () => graph;
  // Emit in creation order, not arrival order: the node array's order decides
  // whether the renderer can update in place or must rebuild, and coalescing
  // resolves first match first. Neither may depend on which session last moved.
  const ordered = inSessionOrder(sessions);
  const attention = new Map(pilotRoster(sessions).map(p => [p.id, p]));
  let nodes: GraphNode[] = (graph?.nodes ?? []).map(n => ({ ...n, pilotContext: undefined }));
  const contextNodes = new Set(nodes);
  // Keep first-match alias semantics while sessions coalesce/remove nodes.
  const identities = new Map<string, Set<GraphNode>>();
  const keys = (n: GraphNode) => [n.id, n.path, ...(n.memberPaths ?? []), ...(n.sourcePaths ?? [])].filter((key): key is string => typeof key === "string");
  const indexNode = (n: GraphNode) => {
    for (const key of keys(n)) {
      const matches = identities.get(key) ?? new Set<GraphNode>();
      matches.add(n); identities.set(key, matches);
    }
  };
  const append = (n: GraphNode) => { nodes.push(n); indexNode(n); };
  const resolve = (key: string) => identities.get(key)?.values().next().value;
  nodes.forEach(indexNode);
  for (const s of ordered) {
    const context = new Set(s.context);
    for (const n of s.contextNodes ?? []) if (context.has(n.id) && !resolve(n.id)) {
      const node = { ...n, degree: 0, pilotContext: undefined };
      contextNodes.add(node); append(node);
    }
  }
  const redirects = new Map<string, string>();
  const edges: GraphData["edges"] = [];
  for (const s of ordered) {
    const paths = new Set((s.ingestions ?? []).flatMap(r => [r.path, r.sourceId, `source:${r.insertionId}`]));
    const legacy = s.legacyWork;
    if (legacy) { paths.add(sessionPath(legacy.id)); paths.add(legacy.id); }
    const captured = nodes.filter(n => paths.has(n.id) || !!n.path && paths.has(n.path) || n.sessionId === s.id && n.from === "pilot"
      || !!legacy && belongsToSession(n, legacy));
    for (const n of captured) { redirects.set(n.id, s.id); paths.add(n.id); if (n.path) paths.add(n.path); for (const p of [...(n.memberPaths ?? []), ...(n.sourcePaths ?? [])]) paths.add(p); }
    const seed = (s.seed.length ? s.seed : s.context).flatMap(id => { const n = resolve(id); return n ? [n] : []; });
    const x = seed.length ? seed.reduce((v, n) => v + (n.x ?? 0), 0) / seed.length : 0;
    const y = seed.length ? seed.reduce((v, n) => v + (n.y ?? 0), 0) / seed.length : 0;
    const offset = parseInt(s.id.slice(-4), 16) / 65535;
    const styled = attention.has(s.id);
    if (captured.length) {
      const removed = new Set(captured);
      for (const n of captured) for (const key of keys(n)) identities.get(key)?.delete(n);
      nodes = nodes.filter(n => !removed.has(n));
    }
    for (const output of legacy?.outputs ?? []) if (!resolve(output.path) && !resolve(output.id)) {
      append({ id: output.id, path: output.path, title: output.title, group: "source", degree: 0 });
    }
    append({ id: s.id, title: s.title, path: s.ingestions?.at(-1)?.path ?? null, group: styled ? "pilot" : "source", degree: s.context.length,
      layoutAnchors: s.seed.length ? s.seed : s.context, layoutOffset: { x: 45 + offset * 25, y: -45 - offset * 25 },
      memorySupport: Math.max(0, ...captured.map(n => n.memorySupport ?? 0)),
      sourcePaths: [...paths], source: "agent-chat", from: "pilot", sessionId: s.id,
      x: x + 45 + offset * 25, y: y - 45 - offset * 25, pilotActive: attention.has(s.id), pilotNeedsYou: attention.get(s.id)?.state === "waiting",
      pilotPhase: attention.get(s.id)?.phase ?? pilotVisualPhase(s),
      pilotDraft: drafts[s.id] ?? s.draft, live: attention.get(s.id)?.state === "waiting" ? "waiting" : attention.get(s.id)?.state === "running" ? "working" : undefined });
  }
  // Resolve links after every virtual Pilot node exists, including @ mentions
  // of a conversation that occurs later in the session list.
  for (const s of ordered) {
    const styled = attention.has(s.id);
    for (const id of s.context) {
      const n = resolve(id);
      if (n && n.id !== s.id) edges.push({ source: n.id, target: s.id, ...(styled ? { pilotContext: true } : {}) });
    }
  }
  const edgeKey = (a: string, b: string) => [a, b].sort().join("\u0000");
  const seen = new Set(edges.map(e => edgeKey(e.source, e.target)));
  const inheritedEdges: GraphData["edges"] = [];
  for (const e of graph?.edges ?? []) {
    const source = redirects.get(e.source) ?? e.source, target = redirects.get(e.target) ?? e.target;
    if (source === target) continue;
    const key = edgeKey(source, target);
    if (!seen.has(key)) { seen.add(key); inheritedEdges.push({ ...e, source, target }); }
  }
  const hash = `${graph?.hash ?? ""}:pilot:`;
  const revision = sessions.map(s => `${s.id}:${s.lifecycle}:${attention.has(s.id)}:${s.context.join(",")}:${s.ingestions?.length ?? 0}`).sort().join("|");
  const bySession = new Map(sessions.map(s => [s.id, s]));
  const base = { ...graph, layoutBase: graph?.layoutBase ?? graph ?? undefined };
  return activeId => {
    const active = activeId ? bySession.get(activeId) : undefined;
    const activeContext = active ? new Set(active.context) : undefined;
    const alone = active && !active.context.length;
    const visible = alone ? nodes.filter(n => n.id === active.id) : nodes;
    return { ...base, nodes: visible.map(n => ({ ...n, ...(contextNodes.has(n) ? { pilotContext: activeContext?.has(n.id) } : {}),
      ...(active && n.id === active.id ? { group: "pilot", pilotPhase: attention.get(active.id)?.phase ?? pilotVisualPhase(active) } : {}),
    })), edges: alone ? [] : [
      ...edges.map(e => e.target === activeId ? { ...e, pilotContext: true } : e),
      ...inheritedEdges.filter(e => e.source !== activeId && e.target !== activeId),
    ], hash: `${hash}${activeId ?? ""}:${revision}` };
  };
}
