import { expect, test } from "bun:test";
import { headlessCanvas, installHeadlessGraphDom } from "./support/headlessGraph";
installHeadlessGraphDom();
import { GraphRenderer } from "../web/ui/src/lib/graph/renderer";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { withAgentOrchestrator } from "../web/ui/src/lib/agentSessionGraph";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import type { WorkSummary } from "../lib/workViews";
import type { GraphData } from "../web/ui/src/lib/types";
import type { GraphViewState } from "../lib/graphView";

/** The background must hold still while a conversation runs. New topology
 * (a worker appears, a chapter is ingested) still rebuilds the GPU graph, but
 * the rebuilt renderer adopts the camera instead of reframing the vault.
 *
 * Driven headlessly through the production renderer and the production overlay
 * functions — see test/support/headlessGraph.ts for what that does and does not
 * prove. Appearance stays with the browser suite. */

const SIZE = 61;
const vault = (): GraphData => ({ hash: "vault", nodes: [
  { id: "memory/MEMORY.md", path: "memory/MEMORY.md", title: "Memory", group: "memory", degree: 6, x: 0, y: 0 },
  ...Array.from({ length: SIZE }, (_, i) => ({ id: `sources/s${i}.md`, path: `sources/s${i}.md`, title: `Source ${i}`,
    group: "source" as const, degree: 1 + i % 4, x: Math.cos(i) * (200 + i * 6), y: Math.sin(i) * (200 + i * 6) })),
], edges: [
  ...Array.from({ length: SIZE }, (_, i) => ({ source: "memory/MEMORY.md", target: `sources/s${i}.md` })),
  ...Array.from({ length: SIZE - 1 }, (_, i) => ({ source: `sources/s${i}.md`, target: `sources/s${i + 1}.md` })),
] });

const conversation = { ...newPilotChatSession(["sources/s3.md"], "pilot-" + "a".repeat(32), "2026-02-01T00:00:00.000Z"),
  title: "Conversation", phase: "working" as const, messageCount: 3 };
const worker = (id: string, created: string, over: Record<string, unknown> = {}) => ({
  id, title: "Worker", status: "running", provider: "claude", created, updated: created, revision: 1,
  cwd: "/projects/example", origin: { pilot: conversation.id, message: "m1" },
  worker: { projectId: "p", operations: [], isolation: "worktree" }, pending: false,
  ...over } as unknown as WorkSummary);
const compose = (workers: WorkSummary[], session = conversation) =>
  withAgentOrchestrator(withPilotChats(vault(), [session], null), workers)!;

const round = (camera: { x: number; y: number; zoom: number }) =>
  ({ x: +camera.x.toFixed(4), y: +camera.y.toFixed(4), zoom: +camera.zoom.toFixed(6) });
/** Zoom must not move at all — that is the reported symptom. The centre may
 * still drift by a world unit or two, because a new node nudges the layout and
 * the focused conversation is kept revealed; the whole vault's extent is
 * hundreds of units, so this is not a visible reframing. */
const STEADY = 2;
function expectSteady(actual: ReturnType<typeof round>, expected: ReturnType<typeof round>) {
  expect(actual.zoom).toBe(expected.zoom);
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(STEADY);
}

/** The production data effect of web/ui/src/components/LinkGraph.svelte: update
 * in place when the geometry is unchanged, otherwise rebuild and adopt. */
class Shell {
  renderer: GraphRenderer;
  rebuilds = 0;
  time = 10_000;
  private canvas = headlessCanvas();
  constructor(graph: GraphData, private view: GraphViewState, private selected: string | null, private adopt = true) {
    this.renderer = this.build(graph);
  }
  private build(graph: GraphData) {
    const carried = this.rebuilds ? this.renderer.getCameraState() : null;
    if (this.rebuilds) this.renderer.dispose();
    this.rebuilds++;
    const next = new GraphRenderer(this.canvas, graph, { top: 0, bottom: 0 }, 560, "none");
    next.update(graph, null);
    next.setView(this.view, this.selected, this.time, false, false);
    if (this.adopt && carried?.ready) next.adoptCamera(carried.camera, carried.manual, this.time);
    return next;
  }
  data(graph: GraphData) { if (!this.renderer.update(graph, null)) this.renderer = this.build(graph); }
  run(ms: number) { for (let i = 0; i < Math.ceil(ms / 16); i++) { this.time += 16; this.renderer.draw(this.time); } }
  camera() { return round(this.renderer.getCamera()); }
  manual() { return this.renderer.getCameraState().manual; }
}

const focus: GraphViewState = { selected: [conversation.id], excluded: [] };

test("a worker appearing rebuilds the graph without reframing the focused conversation", () => {
  const shell = new Shell(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]), focus, conversation.id);
  shell.run(2000);
  const resting = shell.camera();
  shell.data(compose([worker("wk_1", "2026-05-01T00:00:00.000Z"), worker("wk_2", "2026-05-02T00:00:00.000Z")]));
  expect(shell.rebuilds).toBe(2); // new topology: the rebuild itself is intended
  shell.run(16);
  expect(shell.camera()).toEqual(resting); // ...the reframing is not
  shell.run(2000);
  expectSteady(shell.camera(), resting);
  shell.data(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]));
  shell.run(2000);
  expectSteady(shell.camera(), resting);

  // Without adoption the same sequence is the reported symptom: a silent,
  // un-animated jump on the very first frame after each rebuild.
  const shipped = new Shell(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]), focus, conversation.id, false);
  shipped.run(2000);
  const before = shipped.camera();
  shipped.data(compose([worker("wk_1", "2026-05-01T00:00:00.000Z"), worker("wk_2", "2026-05-02T00:00:00.000Z")]));
  shipped.run(16);
  expect(shipped.camera().zoom).not.toBe(before.zoom);
});

test("a rebuild keeps a hand-set camera, and never snaps when it must move", () => {
  const shell = new Shell(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]), focus, conversation.id);
  shell.run(2000);
  shell.renderer.zoomAt({ x: 720, y: 500 }, 3, shell.time);
  shell.run(1200);
  const held = shell.camera();
  expect(shell.manual()).toBe(true);
  shell.data(compose([worker("wk_1", "2026-05-01T00:00:00.000Z"), worker("wk_2", "2026-05-02T00:00:00.000Z")]));
  shell.run(1200);
  expect(shell.camera()).toEqual(held); // the hand's camera is exact: nothing follows
  expect(shell.manual()).toBe(true);

  // An overview with no focus does have to refit around genuinely new geometry;
  // it flies there from the adopted camera rather than cutting to it.
  const overview = new Shell(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]), { selected: [], excluded: [] }, null);
  overview.run(2000);
  const home = overview.camera();
  overview.data(compose([worker("wk_1", "2026-05-01T00:00:00.000Z"), worker("wk_2", "2026-05-02T00:00:00.000Z")]));
  overview.run(16);
  expect(overview.camera()).toEqual(home);
  overview.run(2000);
  expect(overview.camera().zoom).not.toBe(home.zoom);
});

test("re-sending the view already on screen leaves the hand alone; navigation and refit still move", () => {
  const shell = new Shell(compose([worker("wk_1", "2026-05-01T00:00:00.000Z")]), focus, conversation.id);
  shell.run(2000);
  shell.renderer.zoomAt({ x: 720, y: 500 }, 3, shell.time);
  shell.run(1200);
  const held = shell.camera();

  // What a background refresh does: the same view, the same focus, again.
  shell.renderer.setView(focus, conversation.id, shell.time, false, false);
  shell.run(1200);
  expect(shell.camera()).toEqual(held);
  expect(shell.manual()).toBe(true);

  // A click on the already selected node is explicit, and still recentres.
  shell.renderer.setView(focus, conversation.id, shell.time, false, false, "navigate");
  expect(shell.manual()).toBe(false);
  shell.run(1200);
  expect(shell.camera()).not.toEqual(held);

  // Escape / double-click still reframes the whole vault.
  shell.renderer.zoomAt({ x: 720, y: 500 }, 3, shell.time);
  shell.run(1200);
  const zoomed = shell.camera();
  shell.renderer.refit(shell.time);
  shell.run(2000);
  expect(shell.manual()).toBe(false);
  expect(shell.camera()).not.toEqual(zoomed);

  // Selecting a different node is a real view change, and is honoured at once.
  const settled = shell.camera();
  shell.renderer.select("sources/s40.md", shell.time);
  shell.run(1200);
  expect(shell.camera()).not.toEqual(settled);
});

test("status, title and ordering churn updates in place: no rebuild, no camera move", () => {
  const first = worker("wk_1", "2026-05-01T00:00:00.000Z"), second = worker("wk_2", "2026-05-02T00:00:00.000Z");
  // `work.sessions` is held newest-updated first.
  const shell = new Shell(compose([second, first]), focus, conversation.id);
  shell.run(2000);
  const resting = shell.camera();
  // A worker reports: status, operations and list position all change.
  const reported = worker("wk_1", "2026-05-01T00:00:00.000Z", { status: "waiting", updated: "2026-05-03T00:00:00.000Z",
    worker: { projectId: "p", operations: [{ id: "o1", tool: "Read", status: "done", at: "" }], isolation: "worktree" } });
  shell.data(compose([reported, second]));
  // The conversation is updated and moves to the end of the client's array.
  shell.data(compose([reported, second], { ...conversation, phase: "answered", title: "Renamed", revision: 9 }));
  shell.run(2000);
  expect(shell.rebuilds).toBe(1);
  expect(shell.camera()).toEqual(resting);
});
