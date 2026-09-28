import { expect, test } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import type { WorkSummary } from "../lib/workViews";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { withAgentOrchestrator } from "../web/ui/src/lib/agentSessionGraph";
import { graphGeometryKey } from "../web/ui/src/lib/graph/status";
import type { GraphData } from "../web/ui/src/lib/types";

/** The overlay decides the graph's node array, and the renderer's buffers are
 * index-aligned to it: a reshuffle is indistinguishable from new topology, so
 * `LinkGraph` throws the GPU graph away and reframes the camera. Activity
 * reorders the live arrays constantly (an accepted update moves a conversation
 * to the end, a worker's report re-sorts by recency), so the overlay must emit
 * in an order that only real creation and removal can change. */

const vault = (): GraphData => ({ hash: "vault", nodes: [
  { id: "memory/MEMORY.md", path: "memory/MEMORY.md", title: "Memory", group: "memory", degree: 2, x: 0, y: 0 },
  { id: "sources/one.md", path: "sources/one.md", title: "One", group: "source", degree: 1, x: 100, y: 0 },
  { id: "sources/two.md", path: "sources/two.md", title: "Two", group: "source", degree: 1, x: -100, y: 0 },
], edges: [
  { source: "memory/MEMORY.md", target: "sources/one.md" },
  { source: "memory/MEMORY.md", target: "sources/two.md" },
] });

const older = { ...newPilotChatSession(["sources/one.md"], "pilot-" + "b".repeat(32), "2026-02-01T00:00:00.000Z"),
  title: "Older conversation", phase: "answered" as const, messageCount: 4 };
const newer = { ...newPilotChatSession(["sources/two.md"], "pilot-" + "a".repeat(32), "2026-03-01T00:00:00.000Z"),
  title: "Newer conversation", phase: "answered" as const, messageCount: 2 };

const overlay = (sessions: typeof older[]) => withPilotChats(vault(), sessions, null)!;
const ids = (graph: GraphData) => graph.nodes.map(n => n.id);

test("conversation overlay emits in creation order, so an accepted update is not new geometry", () => {
  const settled = overlay([older, newer]);
  // Creation order, not the order the client happened to hold them in.
  expect(ids(settled).slice(-2)).toEqual([older.id, newer.id]);
  expect(ids(overlay([newer, older]))).toEqual(ids(settled));
  expect(graphGeometryKey(overlay([newer, older]))).toBe(graphGeometryKey(settled));
  expect(overlay([newer, older]).hash).toBe(settled.hash);

  // What `accept()` does today: the updated session moves to the end of the
  // array. Phase, title, draft and revision are not geometry.
  const bumped = { ...older, phase: "working" as const, title: "Renamed", draft: "half a thought", revision: older.revision + 1 };
  expect(graphGeometryKey(overlay([newer, bumped]))).toBe(graphGeometryKey(settled));
  expect(ids(overlay([newer, bumped]))).toEqual(ids(settled));
});

test("a conversation appearing, gaining context or leaving is still a rebuild", () => {
  const settled = overlay([older, newer]);
  const third = { ...newPilotChatSession([], "pilot-" + "c".repeat(32), "2026-04-01T00:00:00.000Z"), title: "Third", phase: "answered" as const, messageCount: 1 };
  expect(graphGeometryKey(overlay([older, newer, third]))).not.toBe(graphGeometryKey(settled));
  expect(graphGeometryKey(overlay([newer]))).not.toBe(graphGeometryKey(settled));
  expect(graphGeometryKey(overlay([older, { ...newer, context: [...newer.context, "sources/one.md"] }]))).not.toBe(graphGeometryKey(settled));
});

const worker = (id: string, created: string, over: Partial<WorkSummary> = {}) => ({
  id, title: "Worker", status: "running", provider: "claude", created, updated: created, revision: 1,
  cwd: "/projects/example", origin: { pilot: older.id, message: "m1" },
  worker: { projectId: "p", operations: [], isolation: "worktree" }, pending: false,
  ...over } as unknown as WorkSummary);

const withWorkers = (sessions: WorkSummary[]) => withAgentOrchestrator(overlay([older, newer]), sessions)!;

test("worker overlay emits in creation order, so progress reports are not new geometry", () => {
  const first = worker("wk_1", "2026-05-01T00:00:00.000Z"), second = worker("wk_2", "2026-05-02T00:00:00.000Z");
  // `work.sessions` is held sorted by `updated` descending, newest first.
  const settled = withWorkers([second, first]);
  expect(ids(settled).slice(-2)).toEqual(["wk_1", "wk_2"]);
  // A report re-sorts the list: the older worker overtakes its sibling.
  const reported = { ...first, status: "waiting", updated: "2026-05-03T00:00:00.000Z", revision: 2,
    worker: { projectId: "p", operations: [{ id: "o1", tool: "Read", status: "done", at: "" }], isolation: "worktree" } } as unknown as WorkSummary;
  const churned = withWorkers([reported, second]);
  expect(ids(churned)).toEqual(ids(settled));
  expect(graphGeometryKey(churned)).toBe(graphGeometryKey(settled));
  expect(churned.hash).toBe(settled.hash);
});

test("a worker starting or finishing is still a rebuild", () => {
  const first = worker("wk_1", "2026-05-01T00:00:00.000Z"), second = worker("wk_2", "2026-05-02T00:00:00.000Z");
  const settled = withWorkers([second, first]);
  expect(graphGeometryKey(withWorkers([first]))).not.toBe(graphGeometryKey(settled));
  expect(graphGeometryKey(withWorkers([first, second, worker("wk_3", "2026-05-03T00:00:00.000Z")]))).not.toBe(graphGeometryKey(settled));
});
