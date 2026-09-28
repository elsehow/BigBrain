import { expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertionGraphEvidenceAsync, invalidateGraphCaches, primaryGraphAsync, primaryGraphWithLayoutAsync, readLayoutCache } from "../lib/graphCache";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { sourceInsertionCached } from "../lib/assertionEntityView";
import { insertion } from "./support/vault";
import { withVaultSnapshot } from "../lib/vaultReadModel";
import { createLive } from "../lib/liveEvents";

const roots: string[] = [];
function fresh() { const root = mkdtempSync(join(tmpdir(), "bb-graph-background-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) { invalidateGraphCaches(root); rmSync(root, { recursive: true, force: true }); } });
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

test("an invalidation during a worker build cannot publish an obsolete snapshot", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  const first = primaryGraphAsync(root);
  appendSourceInsertionEvent(root, source("2"));
  invalidateGraphCaches(root);
  const second = primaryGraphAsync(root);
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(a.nodes.map(n => n.id)).toEqual([`source:${source("1").id}`, `source:${source("2").id}`]);
});

test("a worker error rejects readers and a repaired vault can retry", async () => {
  const root = fresh(), item = source("1");
  appendSourceInsertionEvent(root, item);
  writeFileSync(join(root, insertionEventRel(item)), "broken json");
  await expect(primaryGraphAsync(root)).rejects.toThrow("unreadable event");
  writeFileSync(join(root, insertionEventRel(item)), JSON.stringify(item));
  expect((await primaryGraphAsync(root)).nodes).toHaveLength(1);
});

test("layout requests stay fresh when invalidated while the worker is running", async () => {
  const root = fresh();
  appendSourceInsertionEvent(root, source("1"));
  await primaryGraphAsync(root);
  const pending = primaryGraphWithLayoutAsync(root);
  await Promise.resolve();
  appendSourceInsertionEvent(root, source("2"));
  invalidateGraphCaches(root);
  const latest = await primaryGraphWithLayoutAsync(root);
  const earlier = await pending;
  expect(earlier.hash).toBe(latest.hash);
  expect(earlier.nodes).toHaveLength(2);
  expect(earlier.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  expect(readLayoutCache(root)?.hash).toBe(latest.hash);
});

test("stopping the watcher suppresses a ping from an outstanding async warm", async () => {
  const root = fresh(), writes: string[] = [];
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const warming = new Promise<void>(resolve => { release = resolve; });
  const live = createLive({ root, debounceMs: 1, refresh: () => {}, warmLayout: () => { entered(); return warming; } });
  live.addClient({ write: text => writes.push(text) });
  live.handleChange("memory/index.md");
  await started;
  live.stop(); release();
  await Bun.sleep(5);
  expect(writes).toEqual([]);
});

test("async readers observe a newly projected filing verdict before the watcher fires", async () => {
  const { projectSourceInsertion, appendAndProjectDecline } = await import("../lib/assertionProjection");
  const { createDeclineEvent } = await import("../lib/declineLog");
  const root = fresh(), item = source("1");
  appendSourceInsertionEvent(root, item); projectSourceInsertion(root, item);
  expect((await primaryGraphAsync(root)).nodes[0]?.pending).toBe(true);
  appendAndProjectDecline(root, createDeclineEvent({ insertion_ids: [item.id], reason: "Boilerplate",
    author: { kind: "model", id: "gardener", invocation_id: "test" }, produced_by: { procedure: "intake", version: "v1" },
    created_at: "2026-09-20T00:00:00.000Z" }, new Map([[item.id, item]])));
  expect((await primaryGraphAsync(root)).nodes[0]?.pending).toBeUndefined();
});

test("a newer watcher change suppresses the older in-flight ping", async () => {
  const root = fresh(), writes: string[] = [], releases: Array<() => void> = [];
  const live = createLive({ root, debounceMs: 1, refresh: () => {},
    warmLayout: () => new Promise<void>(resolve => releases.push(resolve)) });
  live.addClient({ write: text => writes.push(text) });
  try {
    live.handleChange("memory/first.md");
    await Bun.sleep(5);
    live.handleChange("memory/second.md");
    await Bun.sleep(5);
    expect(releases).toHaveLength(2);
    releases[0]!(); await Promise.resolve();
    expect(writes).toEqual([]);
    releases[1]!(); await Promise.resolve();
    expect(writes).toEqual(['data: {"changed":true}\n\n']);
  } finally { live.stop(); for (const release of releases) release(); }
});
