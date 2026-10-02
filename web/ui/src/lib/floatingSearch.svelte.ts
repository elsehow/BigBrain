import { recentHits, nestRecentHits } from "./recentHits";
import { vaultFetch as fetch } from "./vaultScope";
import { mergePilotSummary } from "./pilotChatSync";
import { matchesPilotQuery, type PilotChatSummary } from "../../../../lib/pilotChatSummary";
import type { PilotChatDetail } from "./pilotChatSync";
import { sourceAttention, refreshSourceAttention } from "./sourceAttention.svelte";
import { sourceReadIndex, sourceUnreadKey } from "./sourceReadIndex";
import { scanUnreadPage } from "./unreadSearch";
import { api, type RecentPage } from "./api";
import { createPagedSearch, emptyPagedResults } from "./pagedSearch";
import type { SearchHit } from "./omnibox.svelte";
import { chat, chatSessions } from "./pilotChat.svelte";
import { work } from "./workSessions.svelte";
import { withWorkSearch } from "./workSearch";
import { withPilotSearch } from "./pilotSearch";

// Fetch ahead of the three visible rows. Recents warm on startup/live changes
// and survive reloads via the same session cache as the other read endpoints.
const RECENT_PAGE = 50;
export { recentHits } from "./recentHits";
let recentRequest: { revision: number; promise: Promise<RecentPage>; at: number } | undefined;
let revision = 0;
export function firstRecents(): Promise<RecentPage> {
  if (!recentRequest || recentRequest.revision !== revision || Date.now() - recentRequest.at >= 15_000) {
    const current = { revision, at: Date.now(), promise: api.recent(RECENT_PAGE, 0, AbortSignal.timeout(12_000)) };
    recentRequest = current;
    void current.promise.catch(() => { if (recentRequest === current) recentRequest = undefined; });
  }
  return recentRequest.promise;
}
export function warmRecents(nextRevision: number): void {
  revision = nextRevision;
  void firstRecents().catch(() => {});
}
// The sidebar study gives conversations their own A-key list.
export const searchPresentation = $state({ includeAgents: true, unreadOnly: false });
// Track the same effective membership as badges, without restarting for graph
// geometry or unchanged provider polls. Svelte tracks node aliases and rows.
const unreadContext = $derived(sourceUnreadKey(sourceReadIndex(chat.graph?.nodes ?? [], sourceAttention.rows)));
export function unreadSearchContext(): string { return unreadContext; }
export const floatingResults = $state(emptyPagedResults<SearchHit>());
export const floatingSearch = createPagedSearch(floatingResults, async (q, offset, signal) => {
  if (q) {
    const [page, response] = await Promise.all([api.searchPage(q, offset, 50, signal), fetch(`/api/pilot/chat?query=${encodeURIComponent(q)}`, { signal })]);
    if (!response.ok) throw new Error("Pilot history search is unavailable.");
    const { sessions } = await response.json() as { sessions: (PilotChatSummary | PilotChatDetail)[] };
    const matches = sessions.filter(s => !("messages" in s) || matchesPilotQuery(s, q)).map(s => "messages" in s ? s : mergePilotSummary(s));
    return { ...page, hits: withPilotSearch(page.hits, matches, q, { graph: chat.graph, matches: new Set(matches.map(s => s.id)) }) };
  }
  if (searchPresentation.unreadOnly) {
    if (!sourceAttention.checked) await refreshSourceAttention();
    signal.throwIfAborted();
    const readStates = sourceReadIndex(chat.graph?.nodes ?? [], sourceAttention.rows);
    return scanUnreadPage(async (next, signal) => recentHits(await api.recent(100, next, signal)), readStates, offset, signal, RECENT_PAGE);
  }
  // The initial prefetch is shared with opening the popup; dismissing it must
  // not abort the warm that will make the next opening instant.
  return recentHits(await (offset ? api.recent(RECENT_PAGE, offset, signal) : firstRecents()));
}, { project: (hits, q) => {
  const rows = withPilotSearch(withWorkSearch(hits, work.sessions, q, { idleOnly: true }), chatSessions(), q, { graph: chat.graph, idleOnly: true });
  const visible = searchPresentation.includeAgents ? rows : rows.filter(hit => hit.dir !== "pilot" && hit.dir !== "agent" && !hit.agentState && !hit.sessionId && !hit.note.path.startsWith("sessions/"));
  return q ? visible : nestRecentHits(visible);
}, cached: q => {
  if (q || searchPresentation.unreadOnly) return undefined;
  const held = api.cachedRecent(RECENT_PAGE, 0);
  return held ? recentHits(held) : undefined;
} });
