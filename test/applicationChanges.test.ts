import { expect, test } from "bun:test";
import { ApplicationChanges } from "../lib/applicationChanges";
import { ApplicationCursor, applicationResponseCurrent, epochRequest, updatePump } from "../web/ui/src/lib/applicationUpdates";
import { createLive } from "../lib/liveEvents";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { workDetail, type WorkSession } from "../lib/workHistory";

test("coalesced application traffic does not invalidate vault topology, while external edits do", async () => {
  const changes = new ApplicationChanges(), chunks: string[] = [];
  let refreshes = 0, recoveries = 0, layouts = 0, stamped = 0;
  const live = createLive({ root: "/tmp/fabricated-application-vault", applicationChanges: changes,
    stamps: () => ({ generation: "g", revision: String(++stamped), views: { graph: "", joined: "", feed: "", files: "" } }),
    watch: () => ({ close() {} }), refresh: () => { refreshes++; },
    recover: async () => { recoveries++; return false; }, warmLayout: () => { layouts++; }, debounceMs: 0 });
  live.start(); live.addClient({ write: c => chunks.push(c) });
  try {
    for (let revision = 1; revision <= 100; revision++) changes.changed("work", "work-fixture", revision);
    changes.flush();
    expect(chunks.length).toBe(3); expect(chunks[2]).toContain('"revision":100');
    expect([recoveries, refreshes, layouts]).toEqual([1, 0, 0]);
    live.handleChange("journal/model-runs/2026-09/fixture.json");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(chunks.at(-1)).toContain("event: usage");
    expect([recoveries, refreshes, layouts]).toEqual([1, 0, 0]);
    live.handleChange("memory/fixture.md");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(layouts).toBe(1); expect(chunks.at(-1)).toContain("event: views");
  } finally { live.stop(); }
});

test("cursor repairs gaps, restarts and reconnects, ignoring duplicate and out of order batches", () => {
  const c = new ApplicationCursor();
  const event = (epoch: string, revision: number, snapshot = false) => ({ epoch, revision, snapshot, entities: [] });
  expect(c.receive(event("first", 0, true))?.snapshot).toBe(true);
  expect(c.receive(event("first", 1))?.snapshot).toBe(false);
  expect(c.receive(event("first", 1))).toBeUndefined();
  expect(c.receive(event("first", 0))).toBeUndefined();
  expect(c.receive(event("first", 3))?.snapshot).toBe(true);
  expect(c.receive(event("second", 0, true))?.snapshot).toBe(true);
  expect(c.receive(event("second", 0, true))?.snapshot).toBe(true);
});

test("the first connect snapshot adopts an epoch; a later epoch is a restart (#6)", async () => {
  const snapshot = (c: ApplicationCursor, ...epochs: string[]) => { for (const epoch of epochs) c.receive({ epoch, revision: 0, snapshot: true, entities: [] }); };
  // A read begun before the first connection, answered after its snapshot,
  // predates the subscription: it is read again, not reported as a restart.
  const reading = new ApplicationCursor();
  let reads = 0;
  expect(await epochRequest(async () => { if (++reads === 1) snapshot(reading, "first"); return reads; }, true, reading)).toBe(2);
  expect(await epochRequest(async () => ++reads, true, reading)).toBe(3);

  // A write is never repeated; before any connection it has no epoch to be stale against.
  const writing = new ApplicationCursor();
  let writes = 0;
  expect(await epochRequest(async () => { snapshot(writing, "first"); return ++writes; }, false, writing)).toBe(1);
  expect(applicationResponseCurrent("", writing)).toBe(true);
  snapshot(writing, "second");
  expect(applicationResponseCurrent("", writing)).toBe(false);
  expect(applicationResponseCurrent("first", writing)).toBe(false);

  const restarted = new ApplicationCursor(); snapshot(restarted, "first");
  await expect(epochRequest(async () => snapshot(restarted, "second"), true, restarted)).rejects.toThrow("The engine restarted");
  const preConnect = new ApplicationCursor();
  await expect(epochRequest(async () => snapshot(preConnect, "first", "second"), false, preConnect)).rejects.toThrow("The engine restarted");
});

test("an invalidation arriving during a snapshot is drained afterward", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: unknown[] = [];
  const pump = updatePump(async update => { seen.push(update); if (seen.length === 1) await gate; });
  const first = pump.push({ snapshot: true, entities: [] });
  await pump.push({ snapshot: false, entities: [{ kind: "pilot", id: "fixture", revision: 2 }] });
  await pump.push({ snapshot: false, entities: [{ kind: "pilot", id: "fixture", revision: 3 }] });
  release(); await first;
  expect(seen).toEqual([{ snapshot: true, entities: [] }, { snapshot: false, entities: [{ kind: "pilot", id: "fixture", revision: 3 }] }]);
});

test("public records exclude new private fields at every nested boundary", () => {
  const s = newPilotChatSession([]);
  const secret = { secret: "PRIVATE-SENTINEL" };
  Object.assign(s, secret, { githubActions: { pending: secret }, turn: { id: "turn", status: "running" },
    messages: [{ id: "m", role: "assistant", text: "Visible answer", at: s.created, ...secret }],
    backend: { adapter: "pi", provider: "fixture", model: "fixture", ...secret },
    notifications: [{ id: "n", pilotId: s.id, pilotTitle: s.title, messageId: "m", key: "key", text: "Visible question", kind: "question", at: s.created, seen: false, ...secret }] });
  const detail = pilotChatDetail(s);
  expect(JSON.stringify(detail)).not.toContain("PRIVATE-SENTINEL");
  expect(detail.messages[0].text).toBe("Visible answer");
  const w = { id: "work", title: "Task", provider: "pi", cwd: "", status: "idle", created: s.created, updated: s.created, context: { ...secret }, receipts: [], messages: [], ...secret,
    worker: { operations: [{ id: "op", tool: "write", status: "uncertain", at: s.created, ...secret }], ceiling: secret } } as unknown as WorkSession;
  expect(JSON.stringify(workDetail(w))).not.toContain("PRIVATE-SENTINEL");
  expect(workDetail(w).worker?.operations[0].status).toBe("uncertain");
});
