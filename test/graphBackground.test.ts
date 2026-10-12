import { expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertionGraphEvidenceAsync, invalidateGraphCaches, readLayoutCache } from "../lib/graphCache";
import { currentGraph, forgetGraphView, maintainGraphView, saveGraphView, savedGraph, type BuildGraphView } from "../lib/maintainedGraph";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { projectJournal, projectionRevision, projectSourceInsertion } from "../lib/assertionProjection";
import { sourceInsertionCached } from "../lib/assertionEntityView";
import { insertion } from "./support/vault";
import { withVaultSnapshot } from "../lib/vaultReadModel";
import { createLive } from "../lib/liveEvents";

const roots: string[] = [];
function fresh() { const root = mkdtempSync(join(tmpdir(), "bb-graph-background-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { invalidateGraphCaches(root); forgetGraphView(root); rmSync(root, { recursive: true, force: true }); } });
const source = (digit: string) => insertion({ id: `ins_${digit.repeat(24)}`, title: `Source ${digit}` });

test("concurrent async readers share graph/evidence and prepare feed pages for that revision", async () => {
  const root = fresh(), item = source("1");
  appendSourceInsertionEvent(root, item);
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory", "index.md"), `# Memory\n\n[[${insertionEventRel(item)}]]`);
  const connections: unknown[] = [];
  const expected = buildAssertionGraph(root, (from, to, evidence) => connections.push({ from, to, evidence }));
  invalidateGraphCaches(root);
  const [a, b] = await Promise.all([assertionGraphEvidenceAsync(root), assertionGraphEvidenceAsync(root)]);
  expect(a).toBe(b);
  expect(a.graph).toEqual(expected);
  expect(a.connections).toEqual(connections);
  expect(sourceInsertionCached(root, insertionEventRel(item))).toEqual(item);
  withVaultSnapshot(root, db => {
    expect(db.query("SELECT v FROM meta WHERE k = 'feed_revision'").get()).toEqual({ v: a.revision });
    expect(db.query("SELECT count(*) AS n FROM read_feed").get()).toEqual({ n: 1 });
  });
});

test("a commit during a build runs it again: the view ends at the projection's revision", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  const first = maintainGraphView(root);
  appendSourceInsertionEvent(root, source("2")); projectSourceInsertion(root, source("2"));
  const second = maintainGraphView(root);
  await Promise.all([first, second]);
  expect(savedGraph(root)!.nodes.map(n => n.id)).toEqual([`source:${source("1").id}`, `source:${source("2").id}`]);
});

test("a start serves the view saved last session, with no build when nothing moved", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  await maintainGraphView(root);
  saveGraphView(root);
  forgetGraphView(root); // a new process
  let builds = 0;
  const counting: BuildGraphView = async () => { builds++; throw new Error("no build expected"); };
  expect((await currentGraph(root, counting)).nodes.map(n => n.id)).toEqual([`source:${source("1").id}`]);
  await maintainGraphView(root, counting);
  expect(builds).toBe(0);
});

test("a journal write moves the revision but never rebuilds the view; a commit does", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  await maintainGraphView(root);
  let builds = 0;
  const counting: BuildGraphView = async (r) => { builds++; const { buildGraphView } = await import("../lib/maintainedGraph"); return buildGraphView(r); };
  mkdirSync(join(root, "journal", "tend", "2026-10"), { recursive: true });
  writeFileSync(join(root, "journal", "tend", "2026-10", "run-1.json"), "{}");
  const before = projectionRevision(root);
  projectJournal(root, "journal/tend/2026-10/run-1.json"); // as tend logs it
  expect(projectionRevision(root)).not.toBe(before);
  await maintainGraphView(root, counting);
  await currentGraph(root, counting); // the view now stands at the new revision
  expect(builds).toBe(0);
  appendSourceInsertionEvent(root, source("2")); projectSourceInsertion(root, source("2"));
  await maintainGraphView(root, counting);
  expect(builds).toBe(1);
});

test("a worker error rejects readers and a repaired vault can retry", async () => {
  const root = fresh(), item = source("1");
  appendSourceInsertionEvent(root, item);
  writeFileSync(join(root, insertionEventRel(item)), "broken json");
  await expect(currentGraph(root)).rejects.toThrow("unreadable event");
  writeFileSync(join(root, insertionEventRel(item)), JSON.stringify(item));
  expect((await currentGraph(root)).nodes).toHaveLength(1);
});

test("the view carries settled positions for its structure, and the layout persists by hash", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  await maintainGraphView(root);
  appendSourceInsertionEvent(root, source("2")); projectSourceInsertion(root, source("2"));
  await maintainGraphView(root);
  const latest = savedGraph(root)!;
  expect(latest.nodes).toHaveLength(2);
  expect(latest.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  expect(readLayoutCache(root)?.hash).toBe(latest.hash);
});

test("stopping the watcher suppresses a ping from an outstanding async warm", async () => {
  const root = fresh(), writes: string[] = [];
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const warming = new Promise<void>(resolve => { release = resolve; });
  const live = createLive({ root, debounceMs: 1, refresh: () => {}, warmLayout: () => { entered(); return warming; } });
  live.addClient({ write: text => writes.push(text) });
  writes.length = 0; // the connection's stamps
  live.handleChange("memory/index.md");
  await started;
  live.stop(); release();
  await Bun.sleep(5);
  expect(writes).toEqual([]);
});

test("a request serves the last view at once and starts the build; no watcher needed", async () => {
  const { projectSourceInsertion, appendAndProjectDecline } = await import("../lib/assertionProjection");
  const { createDeclineEvent } = await import("../lib/declineLog");
  const root = fresh(), item = source("1");
  appendSourceInsertionEvent(root, item); projectSourceInsertion(root, item);
  expect((await currentGraph(root)).nodes[0]?.pending).toBe(true);
  appendAndProjectDecline(root, createDeclineEvent({ insertion_ids: [item.id], reason: "Boilerplate",
    author: { kind: "model", id: "gardener", invocation_id: "test" }, produced_by: { procedure: "intake", version: "v1" },
    created_at: "2026-09-20T00:00:00.000Z" }, new Map([[item.id, item]])));
  expect((await currentGraph(root)).nodes[0]?.pending).toBe(true); // the last view, at once
  await maintainGraphView(root); // the build the request started
  expect(savedGraph(root)!.nodes[0]?.pending).toBeUndefined();
});

test("a newer watcher change suppresses the older in-flight ping", async () => {
  const root = fresh(), writes: string[] = [], releases: Array<() => void> = [];
  let stamped = 0;
  const live = createLive({ root, debounceMs: 1, refresh: () => {},
    stamps: () => ({ generation: "g", revision: String(++stamped), views: { graph: "", joined: "", feed: "", files: "" } }),
    warmLayout: () => new Promise<void>(resolve => releases.push(resolve)) });
  live.addClient({ write: text => writes.push(text) });
  writes.length = 0; // the connection's stamps
  try {
    live.handleChange("memory/first.md");
    await Bun.sleep(5);
    live.handleChange("memory/second.md");
    await Bun.sleep(5);
    expect(releases).toHaveLength(2);
    releases[0]!(); await Promise.resolve();
    expect(writes).toEqual([]);
    releases[1]!(); await Promise.resolve();
    expect(writes).toEqual(['event: views\ndata: {"generation":"g","revision":"2","views":{"graph":"","joined":"","feed":"","files":""}}\n\n']);
  } finally { live.stop(); for (const release of releases) release(); }
});
