import { expect, mock, test } from "bun:test";
import { createDisplayLayout } from "../web/ui/src/lib/graphDisplayLayout";
import { GRAPH_FOCUS } from "../web/ui/src/lib/graphFocus";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import type { GraphData } from "../web/ui/src/lib/types";

const graph: GraphData = { hash: "vault", nodes: [
  { id: "a", title: "A", group: "entity", degree: 1, x: 1000, y: 0 },
  { id: "b", title: "B", group: "entity", degree: 1, x: -1000, y: 0 },
], edges: [{ source: "a", target: "b" }] };

test("opening, closing, and editing Pilot context never rerun the vault layout solver", () => {
  const solve = mock(() => [{ x: 10, y: 20 }, { x: 80, y: 90 }]);
  const layout = createDisplayLayout(solve);
  const expected = layout(graph, GRAPH_FOCUS);
  const session = newPilotChatSession(["a"], `pilot-${"a".repeat(32)}`);
  const view = withPilotChats(graph, [session], session.id)!;
  const opened = layout(view, GRAPH_FOCUS);
  expect(opened.slice(0, 2)).toEqual(expected);
  expect(opened[2]!.x).toBeCloseTo(10 + view.nodes[2]!.layoutOffset!.x);
  expect(opened[2]!.y).toBeCloseTo(20 + view.nodes[2]!.layoutOffset!.y);
  session.context = ["a", "b"];
  layout(withPilotChats(graph, [session], session.id)!, GRAPH_FOCUS);
  layout(withPilotChats(graph, [session], null)!, GRAPH_FOCUS);
  expect(layout(graph, GRAPH_FOCUS)).toEqual(expected);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("an agent alone does not replace or evict the settled overview", () => {
  const solve = mock(() => [{ x: 10, y: 20 }, { x: 80, y: 90 }]);
  const layout = createDisplayLayout(solve), expected = layout(graph, GRAPH_FOCUS);
  const s = newPilotChatSession([]);
  const original = layout(withPilotChats(graph, [s], s.id)!, GRAPH_FOCUS);
  expect(original).toHaveLength(1);
  expect(layout(graph, GRAPH_FOCUS)).toEqual(expected);
  expect(solve).toHaveBeenCalledTimes(1);
  s.context = ["b"];
  const joined = withPilotChats(graph, [s], s.id)!;
  expect(layout(joined, GRAPH_FOCUS)[2]).toEqual(original[0]);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("real graph changes and layout controls still invalidate the display cache", () => {
  const solve = mock(() => [{ x: 10, y: 20 }, { x: 80, y: 90 }]);
  const layout = createDisplayLayout(solve);
  const first = layout(graph, GRAPH_FOCUS); first[0]!.x = 999;
  expect(layout(graph, GRAPH_FOCUS)[0]!.x).toBe(10);
  const updated = { ...graph, hash: "new-vault", nodes: graph.nodes.map(n => ({ ...n, x: 123 })) };
  layout(updated, GRAPH_FOCUS); expect(solve).toHaveBeenCalledTimes(2);
  layout(updated, { ...GRAPH_FOCUS, compactness: 0.5 }); expect(solve).toHaveBeenCalledTimes(3);
});

test("sessions sharing identical context and offsets get separate stable positions", () => {
  const solve = mock(() => [{ x: 10, y: 20 }, { x: 80, y: 90 }]);
  const layout = createDisplayLayout(solve);
  const first = newPilotChatSession(["a"], `pilot-${"f".repeat(28)}abcd`);
  const opened = withPilotChats(graph, [first], first.id)!;
  const original = layout(opened, GRAPH_FOCUS)[2]!;
  const sessions = [first, ...Array.from({ length: 19 }, (_, i) => newPilotChatSession(["a"], `pilot-${i.toString(16).padStart(28, "0")}abcd`))];
  const view = withPilotChats(graph, sessions, sessions[1]!.id)!;
  const positions = layout(view, GRAPH_FOCUS);
  expect(positions[2]).toEqual(original);
  for (let i = 2; i < positions.length; i++) for (let j = 2; j < i; j++) {
    expect(Math.hypot(positions[i]!.x - positions[j]!.x, positions[i]!.y - positions[j]!.y)).toBeGreaterThanOrEqual(56);
  }
  const reordered = withPilotChats(graph, [...sessions].reverse(), null)!;
  const again = layout(reordered, GRAPH_FOCUS);
  for (let i = 0; i < reordered.nodes.length; i++) expect(again[i]).toEqual(positions[view.nodes.findIndex(n => n.id === reordered.nodes[i]!.id)]);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("Pilot placement clears ordinary nodes without moving them, including dormant sessions", () => {
  const session = newPilotChatSession(["a"], `pilot-${"0".repeat(32)}`);
  session.lifecycle = "dormant";
  // The ordinary node B occupies exactly the preferred Pilot position.
  const solve = mock(() => [{ x: 0, y: 0 }, { x: 45, y: -45 }]);
  const layout = createDisplayLayout(solve);
  const view = withPilotChats(graph, [session], null)!;
  const positions = layout(view, GRAPH_FOCUS);
  expect(positions.slice(0, 2)).toEqual([{ x: 0, y: 0 }, { x: 45, y: -45 }]);
  for (const p of positions.slice(0, 2)) expect(Math.hypot(positions[2]!.x - p.x, positions[2]!.y - p.y)).toBeGreaterThan(36);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("historical agent transcripts keep their settled positions despite session IDs", () => {
  const archived: GraphData = { hash: "archived-threads", nodes: [
    ...graph.nodes,
    { id: "claude-transcript", title: "Claude Code — correctness-probe", group: "source", degree: 2, sessionId: "historical-claude-thread", from: "claude-code", source: "agent-chat" },
    { id: "codex-transcript", title: "Codex transcript", group: "source", degree: 1, sessionId: "historical-codex-thread", from: "codex", source: "agent-chat" },
  ], edges: [...graph.edges, { source: "claude-transcript", target: "a" }, { source: "claude-transcript", target: "codex-transcript" }] };
  const settled = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 10, y: 10 }, { x: 15, y: 10 }];
  const solve = mock(() => settled.map(p => ({ ...p }))), layout = createDisplayLayout(solve);
  expect(layout(archived, GRAPH_FOCUS)).toEqual(settled);
  const s = newPilotChatSession(["claude-transcript"]);
  const overlay = withPilotChats(archived, [s], s.id)!;
  expect(layout(overlay, GRAPH_FOCUS).slice(0, 4)).toEqual(settled);
  expect(layout(archived, GRAPH_FOCUS)).toEqual(settled);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("hidden background nodes do not push a Pilot away from the overview and its context", () => {
  const dense: GraphData = { hash: "dense", nodes: [...graph.nodes, ...Array.from({ length: 1000 }, (_, i) =>
    ({ id: `hidden-${i}`, title: "Hidden", group: "source", degree: 0 }))], edges: graph.edges };
  const positions = [{ x: 0, y: 0 }, { x: 60, y: 0 }, ...Array.from({ length: 1000 }, (_, i) =>
    ({ x: (i % 32) * 12 - 190, y: Math.floor(i / 32) * 12 - 190 }))];
  const solve = mock(() => positions), layout = createDisplayLayout(solve);
  const session = newPilotChatSession(["a"], `pilot-${"0".repeat(32)}`);
  const view = withPilotChats(dense, [session], null)!;
  const placed = layout(view, { ...GRAPH_FOCUS, overviewCount: 2 });
  const p = placed.at(-1)!;
  expect(Math.hypot(p.x, p.y)).toBeLessThan(100);
  expect(placed.slice(0, -1)).toEqual(positions);
  expect(layout(view, { ...GRAPH_FOCUS, overviewCount: 2 }).at(-1)).toEqual(p);
  expect(solve).toHaveBeenCalledTimes(1);
});


test("Pilot restarts, context growth, and graph refreshes retain conversation positions", () => {
  const solve = mock((nodes: GraphData["nodes"]) => nodes.map((_, i) => ({ x: i * 80, y: i * 90 })));
  const layout = createDisplayLayout(solve);
  const pilot = newPilotChatSession(["a"]);
  const view = () => withPilotChats(graph, [pilot], pilot.id)!;
  const first = view(), positions = layout(first, GRAPH_FOCUS);
  pilot.phase = "answered"; pilot.lifecycle = "dormant";
  expect(layout(view(), GRAPH_FOCUS)).toEqual(positions);
  pilot.phase = "working"; pilot.lifecycle = "active"; pilot.context.push("b");
  expect(layout(view(), GRAPH_FOCUS)).toEqual(positions);
  expect(solve).toHaveBeenCalledTimes(1);
  const refreshed = withPilotChats({ ...graph, hash: "refreshed" }, [pilot], pilot.id)!;
  const next = layout(refreshed, GRAPH_FOCUS);
  expect(next[refreshed.nodes.findIndex(n => n.id === pilot.id)]).toEqual(positions[first.nodes.findIndex(n => n.id === pilot.id)]);
});

test("hidden context anchors Pilots to its visible graph neighborhood without moving the source", () => {
  const base: GraphData = { hash: "hidden-context", nodes: [
    { id: "hub", title: "Hub", group: "entity", degree: 3 },
    { id: "bridge", title: "Bridge", group: "source", degree: 2 },
    { id: "seed", path: "sources/seed.md", title: "Context", group: "source", degree: 1 },
    { id: "other", title: "Other", group: "source", degree: 1 },
  ], edges: [{ source: "hub", target: "bridge" }, { source: "hub", target: "seed" }, { source: "hub", target: "other" }] };
  const settled = [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: 900, y: 600 }, { x: -500, y: 0 }];
  const solve = mock(() => settled.map(p => ({ ...p }))), layout = createDisplayLayout(solve);
  const pilot = newPilotChatSession(["sources/seed.md"], `pilot-${"0".repeat(32)}`);
  const data = withPilotChats(base, [pilot], null)!;
  const focus = { ...GRAPH_FOCUS, overviewCount: 1 };
  const positions = layout(data, focus), p = positions[data.nodes.findIndex(n => n.id === pilot.id)]!;
  expect(positions.slice(0, 4)).toEqual(settled);
  expect(Math.hypot(p.x, p.y)).toBeLessThan(110);
  expect(layout(data, focus)).toEqual(positions);
  expect(solve).toHaveBeenCalledTimes(1);
});

test("context-free Pilots stay near the overview even in a large vault", () => {
  const base: GraphData = { hash: "large", nodes: [...graph.nodes, ...Array.from({ length: 4000 }, (_, i) => ({ id: `hidden-${i}`, title: "Hidden", group: "source", degree: 0 }))], edges: graph.edges };
  const pilot = newPilotChatSession([]);
  const solve = () => base.nodes.map((_, i) => i < 2 ? { x: i * 60, y: 0 } : { x: 9000, y: 9000 });
  const data = withPilotChats(base, [pilot], null)!;
  const p = createDisplayLayout(solve)(data, { ...GRAPH_FOCUS, overviewCount: 2 }).at(-1)!;
  expect(Math.hypot(p.x - 30, p.y)).toBeLessThan(110);
});
