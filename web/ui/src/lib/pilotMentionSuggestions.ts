import { isUserNode } from "../../../../lib/userNote";
import { contextConnections } from "../../../../lib/contextConnections";
import { graphIdentityIndex } from "../../../../lib/graphIdentity";
import type { MentionItem } from "../../../../lib/pilotMentions";
import type { GraphData } from "./types";

export type MentionSuggestion = MentionItem & { hint?: string };

/** Context-local importance, never global popularity. All inputs stay in memory. */
export function connectedMentions(graph: GraphData | null | undefined, context: string[], bodies: Record<string, string>) {
  if (!graph) return { label: "Connected", items: [] as MentionSuggestion[] };
  const ranked = contextConnections(graph, context, [], bodies).filter(({ node }) => !isUserNode(node, graph.userNote));
  const titles = new Map(graph.nodes.map(n => [n.id, n.title]));
  const items = ranked.map(({ node: n, selected, explicit }): MentionSuggestion => ({
    id: n.path!, title: n.title, tag: n.group === "memory" ? "MEMORY" : n.entity || n.group === "entity" ? "ENTITY" : "SOURCE",
    hint: `${explicit ? "Mentioned in" : "Connected to"} ${titles.get(selected[0]) ?? "this chat"}`,
  }));
  const index = graphIdentityIndex(graph.nodes);
  const names = [...new Set(context.map(id => index.get(id)))].flatMap(i => i === undefined ? [] : [graph.nodes[i].title]);
  return { label: names.length === 1 ? `Connected to ${names[0]}` : "Connected to this chat", items };
}

/** Preserve search relevance: connected hits can move up at most three places. */
export function boostConnectedMentions(hits: MentionItem[], connected: MentionSuggestion[]): MentionSuggestion[] {
  const byId = new Map(connected.map(item => [item.id, item]));
  return hits.map((item, rank) => ({ item: { ...item, hint: byId.get(item.id)?.hint }, rank, score: rank - (byId.has(item.id) ? 3 : 0) }))
    .sort((a, b) => a.score - b.score || a.rank - b.rank).map(row => row.item);
}
