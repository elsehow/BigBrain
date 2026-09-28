import type { WorkSummary } from "../../../../lib/workViews";
import { sessionPath, belongsToSession } from "../../../../lib/workSessionIdentity";
import type { SearchHit } from "./omnibox.svelte";
import { agentVisualState } from "./agentAppearance";
export function withWorkSearch(hits: SearchHit[], sessions: WorkSummary[], query: string, options: { idleOnly?: boolean } = {}): SearchHit[] {
  const found = new Set<string>(), ordinary: SearchHit[] = [];
  for (const hit of hits) {
    const job = sessions.find(s => hit.note.path === sessionPath(s.id) || belongsToSession({ path: hit.note.path, from: hit.from, sessionId: hit.sessionId }, s));
    if (job) found.add(job.id); else ordinary.push(hit);
  }
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const eligible = options.idleOnly && !words.length ? sessions.filter(s => !["running", "waiting"].includes(agentVisualState(s))) : sessions;
  const rows: SearchHit[] = eligible.filter(s => found.has(s.id) || words.every(w => `${s.title} ${s.provider} ${s.model ?? ""}`.toLocaleLowerCase().includes(w))).map(s => ({
    dir: "agent", agentState: agentVisualState(s), agentStatus: s.status, sessionId: s.id, title: s.title, snippet: "",
    note: { path: sessionPath(s.id), name: s.title, size: 0, modified: Date.parse(s.lastActivityAt ?? s.updated) },
  }));
  return query.trim() ? [...rows, ...ordinary] : [...rows, ...ordinary].sort((a, b) => b.note.modified - a.note.modified);
}
