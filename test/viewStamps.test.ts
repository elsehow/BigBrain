import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectJournal, projectSourceInsertion, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { buildGraphView, forgetGraphView, maintainGraphView, type BuildGraphView } from "../lib/maintainedGraph";
import { invalidateGraphCaches } from "../lib/graphCache";
import { createLive } from "../lib/liveEvents";
import { viewStamps, type ViewStamps } from "../lib/viewStamps";
import { recordMoved, viewsBehind } from "../web/ui/src/lib/viewStamps";
import { insertion, nativeVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { invalidateGraphCaches(root); forgetGraphView(root); rmSync(root, { recursive: true, force: true }); } });
const source = (digit: string) => insertion({ id: `ins_${digit.repeat(24)}`, title: `Source ${digit}` });
let builds = 0;
const inline: BuildGraphView = async (root) => { builds++; return buildGraphView(root); };

function vault() {
  const root = nativeVault(); roots.push(root);
  const first = source("1");
  appendSourceInsertionEvent(root, first); projectSourceInsertion(root, first);
  return { root, first };
}
/** The stamps once the graph view has caught up, as the viewer pushes them. */
async function settled(root: string): Promise<ViewStamps> {
  syncAssertionProjection(root);
  await maintainGraphView(root, inline);
  return viewStamps(root, "files");
}

test("each view's stamp moves only with what it reads", async () => {
  const { root, first } = vault();
  const start = await settled(root);
  expect(start.views.graph).not.toBe("");

  // a run journal: the feed reads it, the graph does not, and nothing rebuilds
  builds = 0;
  mkdirSync(join(root, "journal", "feed", "2026-10"), { recursive: true });
  writeFileSync(join(root, "journal", "feed", "2026-10", "run-1.json"), "{}\n");
  projectJournal(root, "journal/feed/2026-10/run-1.json");
  const journaled = await settled(root);
  expect(journaled.revision).not.toBe(start.revision);
  expect(journaled.views.feed).not.toBe(start.views.feed);
  expect(journaled.views.graph).toBe(start.views.graph);
  expect(builds).toBe(0);

  // a memory note: the graph draws it, the feed does not read Markdown
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "index.md"), `# Memory\n\n[[${insertionEventRel(first)}]]\n`);
  const noted = await settled(root);
  expect(noted.revision).not.toBe(journaled.revision);
  expect(noted.views.feed).toBe(journaled.views.feed);
  expect(noted.views.graph).not.toBe(journaled.views.graph);

  // a source: both
  const second = source("2");
  appendSourceInsertionEvent(root, second); projectSourceInsertion(root, second);
  const sourced = await settled(root);
  expect(sourced.views.feed).not.toBe(noted.views.feed);
  expect(sourced.views.graph).not.toBe(noted.views.graph);
});

test("a connection opens with the stamps; a change pushes them only when one moved", async () => {
  const { root } = vault();
  await settled(root);
  const writes: string[] = [];
  const live = createLive({ root, debounceMs: 1, recover: async () => false, warmLayout: (r) => maintainGraphView(r, inline) });
  live.addClient({ write: (text) => writes.push(text) });
  const opened = writes.splice(0).filter((w) => w.startsWith("event: views\n"));
  expect(opened).toHaveLength(1);
  const first = JSON.parse(opened[0]!.split("\ndata: ")[1]!) as ViewStamps;
  try {
    // a note touched without changing: nothing moved, nothing is pushed
    live.handleChange("memory/none.md");
    await Bun.sleep(30);
    expect(writes).toEqual([]);
    // a journal row: the feed's stamp moves
    projectJournal(root, "journal/feed/2026-10/run-2.json");
    live.handleChange("journal/feed/2026-10/run-2.json");
    await Bun.sleep(30);
    const pushed = writes.map((w) => JSON.parse(w.split("\ndata: ")[1]!) as ViewStamps);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.views.feed).not.toBe(first.views.feed);
    expect(pushed[0]!.views.graph).toBe(first.views.graph);
  } finally { live.stop(); }
});

test("/api/graph answers with the view's stamp as its ETag, and 304 when it holds; the feed reports its stamp", async () => {
  const { root } = vault();
  const result = spawnSync(process.execPath, ["-e", `
    const { ROUTES } = await import(${JSON.stringify(new URL("../web/server.ts", import.meta.url).pathname)});
    const { dispatch } = await import(${JSON.stringify(new URL("../lib/httpx.ts", import.meta.url).pathname)});
    const { viewStamps } = await import(${JSON.stringify(new URL("../lib/viewStamps.ts", import.meta.url).pathname)});
    const get = (url, headers = {}) => new Promise((resolve) => {
      let status = 0, head = {};
      dispatch(ROUTES, { method: "GET", url, headers }, {
        writeHead: (code, h = {}) => { status = code; head = h; },
        end: (body) => resolve({ status, head, body: body ?? "" }),
      });
    });
    const graph = await get("/api/graph?current");
    const again = await get("/api/graph", { "if-none-match": graph.head.etag });
    const v2 = await get("/api/v2");
    console.log(JSON.stringify({ graph: { status: graph.status, etag: graph.head.etag, nodes: JSON.parse(graph.body).nodes.length },
      again: { status: again.status, body: again.body }, v2: v2.head["x-bigbrain-stamp"], stamps: viewStamps(${JSON.stringify(root)}, "") }));
    process.exit(0);
  `], { env: { ...process.env, BIGBRAIN_VAULT: root }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const out = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(out.graph).toEqual({ status: 200, etag: `"${out.stamps.views.graph}"`, nodes: 1 });
  expect(out.again).toEqual({ status: 304, body: "" });
  expect(out.v2).toBe(out.stamps.views.feed);
});

test("the client fetches a view only when its own stamp moved", () => {
  const at = (graph: string, feed: string, revision = "1", files = "a", joined = ""): ViewStamps => ({ generation: "g", revision, views: { graph, joined, feed, files } });
  expect(viewsBehind({ graph: "h1", joined: "", feed: "g:3" }, at("h1", "g:3"))).toEqual({ graph: false, feed: false });
  expect(viewsBehind({ graph: "h1", joined: "", feed: "g:3" }, at("h2", "g:3"))).toEqual({ graph: true, feed: false });
  expect(viewsBehind({ graph: "", joined: "", feed: "" }, at("h1", "g:3"))).toEqual({ graph: true, feed: true });
  // joining a shared vault redraws the field it merges into
  expect(viewsBehind({ graph: "h1", joined: "", feed: "g:3" }, at("h1", "g:3", "1", "a", "j1"))).toEqual({ graph: true, feed: false });
  // views without stamps re-read when the record or the watched files move; a first connection is not a move
  expect(recordMoved(null, at("h1", "g:3"))).toBe(false);
  expect(recordMoved(at("h1", "g:3"), at("h1", "g:3"))).toBe(false);
  expect(recordMoved(at("h1", "g:3"), at("h1", "g:3", "2"))).toBe(true);
  expect(recordMoved(at("h1", "g:3"), at("h1", "g:3", "1", "b"))).toBe(true);
});
