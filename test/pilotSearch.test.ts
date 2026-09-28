import { expect, test } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { withPilotSearch } from "../web/ui/src/lib/pilotSearch";
import { pilotTriangleRadius, pilotVisualPhase } from "../web/ui/src/lib/pilotAppearance";
import type { SearchHit } from "../web/ui/src/lib/omnibox.svelte";
import type { WorkSummary } from '../lib/workHistory';
import { withWorkSearch } from '../web/ui/src/lib/workSearch';

const hit = (path: string, modified = 0): SearchHit => ({ dir: "source", title: path, snippet: "", note: { path, name: path, modified, size: 0 } });
test('slash recents show only idle Pilots in last-activity order, while typed search and mentions retain active sessions', () => {
  const old = { ...newPilotChatSession([], 'old', '2026-09-01'), lifecycle: 'dormant' as const, updated: '2026-09-20', phase: 'answered' as const, deactivatedAt: '2026-09-20', title: 'Research old' };
  const recent = { ...newPilotChatSession([], 'recent', '2026-09-02'), lifecycle: 'ingested' as const, lastActivityAt: '2026-09-10', phase: 'answered' as const, deactivatedAt: '2026-09-20', title: 'Research recent' };
  const active = { ...newPilotChatSession([], 'active', '2026-09-19'), phase: 'answered' as const, lastActivityAt: new Date().toISOString(), title: 'Research active',
    ingestions: [{ path: 'chapter', insertionId: 'i', sourceId: 's', through: 1 }] };
  const busy = { ...old, id: 'busy', title: 'Research busy', phase: 'working' as const, deactivatedAt: undefined };
  const sessions = [active, old, recent, busy];
  const hits = [hit('chapter'), hit('note', Date.parse('2026-09-05'))];
  const options = { idleOnly: true };
  expect(withPilotSearch(hits, sessions, '', options).map(h => h.note.path)).toEqual(['recent', 'note', 'old']);
  expect(withPilotSearch(hits, sessions, 'research', options).filter(h => h.dir === 'pilot')).toHaveLength(4);
  expect(withPilotSearch(hits, sessions, '').filter(h => h.dir === 'pilot')).toHaveLength(4);
});
test('slash recents hide active worker aliases without removing them from typed search', () => {
  const sessions = ['working', 'starting', 'needs-input', 'idle', 'stopped'].map((status, i) => ({
    id: status, title: 'Research', provider: 'codex', status, updated: '2026-09-20', lastActivityAt: `2026-09-0${i + 1}`,
  })) as WorkSummary[];
  const hits = [hit('sessions/working.md')];
  expect(withWorkSearch(hits, sessions, '', { idleOnly: true }).map(h => h.sessionId)).toEqual(['stopped', 'idle']);
  expect(withWorkSearch(hits, sessions, 'research', { idleOnly: true })).toHaveLength(5);
});
test("Pilot recents use conversation activity, include optimistic drafts, and preserve closed identity", () => {
  const closed = { ...newPilotChatSession([], "pilot-closed", "2026-09-02T00:00:00Z"), lifecycle: "ingested" as const,
    updated: "2026-09-15T00:00:00Z", phase: "answered" as const, deactivatedAt: "2026-09-15", title: "Old conversation" };
  const draft = newPilotChatSession([], "pilot-new");
  const rows = withPilotSearch([hit("recent-note", Date.parse("2026-09-13"))], [closed, draft], "");
  expect(rows.map(h => h.note.path)).toEqual([draft.id, "recent-note", closed.id]);
  expect(rows[0].pilotPhase).toBe("draft"); expect(rows[2].pilotPhase).toBe("idle");
  expect(pilotVisualPhase({ ...closed, phase: "working" })).toBe("idle");
});
test("search finds titles and conversation text, and coalesces ingested chapters", () => {
  const s = { ...newPilotChatSession([], "pilot-owned"), title: "Arbor", draft: "Unsent thought",
    messages: [{ id: "m", role: "assistant" as const, text: "Morgan worked on hardening", at: "2026-09-14" }],
    ingestions: [{ path: "sources/chapter.md", insertionId: "i", sourceId: "s", through: 1 }] };
  const historical = { ...hit("claude-transcript"), sessionId: "claude-owned", from: "claude-code" };
  const hits = [hit("sources/chapter.md"), { ...hit("chapter-alias"), sessionId: s.id, from: "pilot" }, historical];
  expect(withPilotSearch(hits, [s], "").filter(h => h.dir === "pilot")).toHaveLength(1);
  expect(withPilotSearch(hits, [s], "").some(h => h.note.path === "sources/chapter.md")).toBe(false);
  expect(withPilotSearch(hits, [s], "").some(h => h.note.path === historical.note.path)).toBe(true);
  for (const q of ["arbor", "MORGAN hardening", "unsent"]) expect(withPilotSearch([], [s], q)).toHaveLength(1);
  expect(withPilotSearch([], [s], "unrelated")).toHaveLength(0);
  // Remote retrieval can match context beyond the local transcript.
  expect(withPilotSearch(hits.slice(0, 1), [s], "context-only term")[0].sessionId).toBe(s.id);
  expect(withPilotSearch([], [], "")).toEqual([]); // discarded optimistic session disappears
});
test("triangle edges meet its actual sides while the selector keeps its circular boundary", () => {
  expect(pilotTriangleRadius(0, 1)).toBe(1);
  expect(pilotTriangleRadius(0, -1)).toBe(.5);
  expect(pilotTriangleRadius(1, 0)).toBeCloseTo(1 / Math.sqrt(3));
  expect(pilotTriangleRadius(-1, 0)).toBeCloseTo(1 / Math.sqrt(3));
});

test("explicitly closed drafts disappear from recents but remain searchable", () => {
  const base = newPilotChatSession([], "closed-draft", "2026-09-21T07:32:00Z");
  const closed = { ...base, title: "Draft session", draft: "Unsent research question",
    lifecycle: "dormant" as const, deactivatedAt: "2026-09-21T07:33:00Z" };
  const conversation = { ...closed, id: "conversation", phase: "answered" as const,
    messages: [{ id: "m", role: "user" as const, text: "Research question", at: base.created }] };
  const activeDraft = { ...base, id: "active-draft", lastActivityAt: new Date().toISOString() };
  for (const draft of [closed, { ...closed, draft: "" }]) {
    const sessions = [draft, conversation, activeDraft];
    // A cached/remote alias cannot reintroduce the closed draft.
    const aliases = [{ ...hit("draft-alias"), from: "pilot", sessionId: draft.id }];
    for (const query of ["", "   "]) {
      expect(withPilotSearch(aliases, sessions, query, { idleOnly: true }).map(h => h.sessionId)).toEqual([conversation.id]);
      expect(withPilotSearch(aliases, sessions, query).map(h => h.sessionId)).toEqual([activeDraft.id, conversation.id]);
    }
  }
  expect(withPilotSearch([], [closed], "unsent research", { idleOnly: true })[0]?.sessionId).toBe(closed.id);
  expect(withPilotSearch([], [{ ...closed, deactivatedAt: undefined, lifecycle: "active" }], "")[0]?.sessionId).toBe(closed.id);
});
