import { expect, test } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { pilotChatSummary, pilotChatDetail, matchesPilotQuery } from "../lib/pilotChatSummary";
import { mergePilotSummary, fullPilotView } from "../web/ui/src/lib/pilotChatSync";

test("an unfiltered status read never scans transcript text", () => {
  const s = newPilotChatSession([]);
  Object.defineProperty(s, "messages", { get() { throw new Error("Transcript was scanned"); } });
  expect(matchesPilotQuery(s, "  ")).toBe(true);
});

test("a 100-conversation index excludes transcript history and stays small", () => {
  const sessions = Array.from({ length: 100 }, (_, i) => {
    const s = newPilotChatSession([], `pilot-${i.toString(16).padStart(32, "0")}`);
    s.messages = Array.from({ length: 20 }, (_, j) => ({ id: `${j}`, role: "user" as const, text: "private transcript ".repeat(100), at: s.created }));
    s.inputs = [{ id: "input", message: "1", mode: "text", text: "private transcript" }];
    s.spoken = [{ id: "speech", message: "1", status: "played", text: "private transcript", at: s.created }];
    s.pendingIngestion = { through: 20, content: "private transcript" };
    return s;
  });
  const index = JSON.stringify(sessions.map(pilotChatSummary));
  expect(index).not.toContain("private transcript");
  expect(index.length).toBeLessThan(100_000);
  expect(sessions.map(pilotChatSummary).every(s => s.messageCount === 20 && s.hasHistory)).toBe(true);
});

test("summary refresh keeps loaded detail and closed history distinguishable from empty drafts", () => {
  const s = newPilotChatSession([]); s.deactivatedAt = s.created;
  s.messages = [{ id: "msg", role: "user", text: "Only searchable in old history", at: s.created }];
  const unloaded = mergePilotSummary(pilotChatSummary(s));
  expect(unloaded.messages).toBeUndefined();
  expect(unloaded.detail.status).toBe("unloaded");
  const loaded = fullPilotView(pilotChatDetail(s)); s.revision++; s.title = "Renamed";
  const refreshed = mergePilotSummary(pilotChatSummary(s), loaded);
  expect(refreshed.messages).toEqual(pilotChatDetail(s).messages);
  expect(refreshed.detail.status).toBe("loaded");
  expect(refreshed.detailRevision).toBeLessThan(refreshed.revision);
  expect(matchesPilotQuery(s, "searchable history")).toBe(true);
});

test("message recency survives unloaded summaries and ignores non-message updates", () => {
  const s = newPilotChatSession([], undefined, "2026-09-01T12:00:00Z");
  s.messages = [
    {id:"user",role:"user",text:"Question",at:"2026-09-02T12:00:00Z"},
    {id:"answer",role:"assistant",text:"Answer",at:"2026-09-03T12:00:00Z"},
  ];
  s.updated = "2026-09-20T12:00:00Z";
  s.lastActivityAt = s.updated;
  const summary = pilotChatSummary(s);
  expect(summary.lastMessageAt).toBe("2026-09-03T12:00:00Z");
  expect(mergePilotSummary(summary).lastMessageAt).toBe(summary.lastMessageAt);
  s.messages.push({id:"followup",role:"user",text:"Follow up",at:"2026-09-04T12:00:00Z"});
  expect(pilotChatSummary(s).lastMessageAt).toBe("2026-09-04T12:00:00Z");
  s.messages = [];
  expect(pilotChatSummary(s).lastMessageAt).toBeUndefined();
});
