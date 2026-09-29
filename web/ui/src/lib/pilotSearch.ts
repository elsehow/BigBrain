import type { PilotViewData } from "./pilotChatSync";
import type { SearchHit } from "./omnibox.svelte";
import { pilotRoster } from "./pilotAttention";
import { pilotVisualPhase } from "./pilotAppearance";
import { belongsToSession } from "../../../../lib/workSessionIdentity";
import { navigationImportance, rankNavigationSearch } from "../../../../lib/navigationSearch";
import type { ImportanceGraph } from "../../../../lib/graphImportance";

/** Merge durable/optimistic sessions with vault hits. Ingested chapters and
 * virtual threads resolve to the same session, even across result pages. */
export function withPilotSearch(hits: SearchHit[], sessions: PilotViewData[], query: string, options: { graph?: ImportanceGraph | null; mention?: boolean; idleOnly?: boolean; matches?: ReadonlySet<string>; delegating?: ReadonlySet<string> } = {}): SearchHit[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const byPath = new Map(sessions.flatMap(s => (s.ingestions ?? []).map(r => [r.path, s] as const)));
  const found = new Set<string>();
  const importance = navigationImportance(options.graph);
  const sessionImportance = new Map<string, number>();
  const ordinary: SearchHit[] = [];
  for (const hit of hits) {
    const session = (hit.from === "pilot" && hit.sessionId ? byId.get(hit.sessionId) : byPath.get(hit.note.path))
      ?? sessions.find(s => s.legacyWork && belongsToSession({ path: hit.note.path, from: hit.from, sessionId: hit.sessionId }, s.legacyWork));
    if (session) {
      found.add(session.id);
      sessionImportance.set(session.id, Math.max(sessionImportance.get(session.id) ?? 0, importance.get(hit.note.path) ?? hit.searchImportance ?? 0));
    }
    else ordinary.push(hit);
  }
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const roster = new Map(pilotRoster(sessions, false, options.delegating).map(p => [p.id, p]));
  const eligible = options.idleOnly && !words.length ? sessions.filter(s => pilotVisualPhase(s) === "idle") : sessions;
  // Ending an unsent draft should not promote it into Recents as an idle
  // conversation. Keep its saved content recoverable through typed search.
  const recentEligible = words.length ? eligible : eligible.filter(s => !(s.phase === "draft" && s.deactivatedAt));
  const pilots = recentEligible.filter(s => found.has(s.id) || options.matches?.has(s.id) || !words.length || words.every(word =>
    `${s.title}\n${s.draft}\n${(s.messages ?? []).map(m => m.text).join("\n")}`.toLocaleLowerCase().includes(word)));
  const rows: SearchHit[] = pilots.map(s => ({ dir: "pilot", sessionId: s.id, from: "pilot", pilotPhase: roster.get(s.id)?.phase ?? pilotVisualPhase(s),
    searchImportance: Math.max(sessionImportance.get(s.id) ?? 0, importance.get(s.id) ?? 0,
      ...(s.ingestions ?? []).map(r => importance.get(r.path) ?? 0)),
    title: s.phase === "draft" && s.draft.trim() && s.title === "New session" ? "Draft session" : s.title, snippet: "",
    note: { path: s.id, name: s.title, size: 0, modified: Date.parse(s.lastActivityAt ?? s.updated ?? s.created) || Date.parse(s.created) || 0 } }));
  // Sessions compete with the same text and graph facts as vault hits.
  return query.trim() ? rankNavigationSearch([...ordinary, ...rows], query, options.graph, options.mention)
    : [...rows, ...ordinary].sort((a, b) => b.note.modified - a.note.modified || a.note.path.localeCompare(b.note.path));
}
