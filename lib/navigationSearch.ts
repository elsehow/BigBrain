import { graphImportance, type ImportanceGraph } from "./graphImportance";
import { graphIdentityIndex } from "./graphIdentity";
import { searchAlternatives } from "./searchQuery";

export interface NavigationHit {
  title: string; alias?: string; dir: string; evidence?: string;
  searchImportance?: number;
  note: { path: string; modified: number };
}
const words = (text: string): string[] => text.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
/** Exact title/alias, then all query terms in the title, then retrieval/body matches. */
export function navigationTextTier(query: string, hit: Pick<NavigationHit, "title" | "alias">): number {
  // The UI also ranks optimistic sessions while the search door validates input.
  let alternatives: string[][];
  try { alternatives = searchAlternatives(query); } catch { alternatives = [words(query)]; }
  return Math.min(...alternatives.flatMap(terms => [hit.title, hit.alias ?? ""].map(title => {
    const q = words(terms.join(" ")), name = words(title);
    if (q.length && q.join("") === name.join("")) return 0;
    return q.length && q.every(term => name.some(word => word.startsWith(term))) ? 1 : 2;
  })), 2);
}
const scores = new WeakMap<ImportanceGraph, Map<string, number>>();
/** Reuse the graph's exact memory-support/connectivity policy, including aliases. */
export function navigationImportance(graph?: ImportanceGraph | null): Map<string, number> {
  if (!graph) return new Map();
  let held = scores.get(graph);
  if (!held) {
    const { scores: values } = graphImportance(graph);
    held = new Map([...graphIdentityIndex(graph.nodes)].map(([key, i]) => [key, values[i]!]));
    scores.set(graph, held);
  }
  return held;
}
const conversation = (hit: NavigationHit) => hit.dir === "pilot" || hit.dir === "agent" || hit.evidence === "agent-conversation" || hit.evidence === "agent-answer";

/** Rank the whole retrieved pool before pagination. Recents have their own date order.
 * Mentions prefer a note/entity over a conversation at the same text-match tier. */
export function rankNavigationSearch<T extends NavigationHit>(hits: T[], query: string, graph?: ImportanceGraph | null, mention = false): T[] {
  const importance = navigationImportance(graph);
  return hits.map((hit, index) => ({ hit: { ...hit, searchImportance: importance.get(hit.note.path) ?? hit.searchImportance ?? 0 },
    tier: navigationTextTier(query, hit), conversation: Number(conversation(hit)), index }))
    .sort((a, b) => a.tier - b.tier
      || (mention ? a.conversation - b.conversation : 0)
      || b.hit.searchImportance - a.hit.searchImportance
      || a.conversation - b.conversation
      || b.hit.note.modified - a.hit.note.modified
      || a.index - b.index)
    .map(row => row.hit);
}
