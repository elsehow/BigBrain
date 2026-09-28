import { expect, test } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { preparePilotChats, withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import type { GraphData } from "../web/ui/src/lib/types";

test("selection reuses chapter coalescing and restores stopped styling and inherited links", () => {
  const a = { ...newPilotChatSession(["memory"], "pilot-" + "a".repeat(32)), lifecycle: "dormant" as const, phase: "answered" as const, deactivatedAt: new Date().toISOString() };
  const b = newPilotChatSession([], "pilot-" + "b".repeat(32));
  let chapterReads = 0;
  const graph: GraphData = { hash: "base", nodes: [
    { id: "memory", title: "Memory", group: "memory", degree: 1 },
    { id: "other", title: "Other", group: "source", degree: 1 },
    { id: "chapter", title: "Chapter", group: "source", degree: 1, from: "pilot", get sessionId() { chapterReads++; return a.id; } },
  ], edges: [{ source: "chapter", target: "other" }] };
  const select = preparePilotChats(graph, [a, b]);
  const preparedReads = chapterReads;
  const first = select(a.id)!;
  expect(first.nodes.some(n => n.id === "chapter")).toBe(false);
  expect(first.nodes.find(n => n.id === a.id)?.group).toBe("pilot");
  expect(first.nodes.find(n => n.id === "memory")?.pilotContext).toBe(true);
  expect(first.edges).toEqual([{ source: "memory", target: a.id, pilotContext: true }]);
  expect(select(b.id)!.nodes.map(n => n.id)).toEqual([b.id]);
  expect(select(b.id)!.edges).toEqual([]);
  const overview = select(null)!;
  expect(overview.nodes.find(n => n.id === a.id)?.group).toBe("source");
  expect(overview.nodes.find(n => n.id === "memory")?.pilotContext).toBeUndefined();
  expect(overview.edges).toContainEqual({ source: a.id, target: "other" });
  expect(select(a.id)).toEqual(first);
  expect(chapterReads).toBe(preparedReads);
  expect(first.layoutBase).toBe(graph);
  a.context = ["other"];
  const updated = preparePilotChats(graph, [a, b])(a.id)!;
  expect(updated.nodes.find(n => n.id === "other")?.pilotContext).toBe(true);
  expect(updated.edges).toContainEqual({ source: "other", target: a.id, pilotContext: true });
});

test("indexed aliases keep the first remaining node after chapter coalescing", () => {
  const a = newPilotChatSession([], "pilot-" + "a".repeat(32));
  const b = newPilotChatSession(["shared", a.id], "pilot-" + "b".repeat(32));
  const graph: GraphData = { nodes: [
    { id: "chapter", title: "Chapter", group: "source", degree: 1, from: "pilot", sessionId: a.id, sourcePaths: ["shared"] },
    { id: "survivor", title: "Survivor", group: "source", degree: 1, memberPaths: ["shared"], x: 100, y: 20 },
    { id: "shared", title: "Later exact ID", group: "source", degree: 1, x: 900 },
  ], edges: [] };
  const result = withPilotChats(graph, [a, b], b.id)!;
  expect(result.edges).toContainEqual({ source: "survivor", target: b.id, pilotContext: true });
  expect(result.edges).toContainEqual({ source: a.id, target: b.id, pilotContext: true });
  expect(result.edges.some(e => e.source === "shared")).toBe(false);
});
