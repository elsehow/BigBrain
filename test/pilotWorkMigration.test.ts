import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./support/vault";
import { WorkHistory, type WorkSession } from "../lib/workHistory";
import { PilotChats } from "./support/pilotSession";
import { migratedPilotId, pilotFromWork, repairMigratedArchive } from "../lib/pilotWorkMigration";
import { DEFAULT_PILOT_BACKEND } from "../lib/pilotBackendTypes";
import { readConversation } from "../lib/pilotConversation";
import { writeAtomic } from "../lib/fsx";
import { sessionPath } from "../lib/workSessionIdentity";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { withPilotSearch } from "../web/ui/src/lib/pilotSearch";
import { canonicalGraphView } from "../lib/graphView";

const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
const at = "2026-09-01T12:00:00.000Z";
const original = (): WorkSession => ({ id: `work-${"a".repeat(32)}`, title: "Severity graph", provider: "claude-code",
  thread: "old-claude-thread", cwd: "/original/project", model: "old-model", status: "idle", context: { nodes: ["topic"] },
  created: at, updated: at, messages: [
    { id: "u", role: "user", text: "Investigate the graph", at },
    { id: "activity", role: "activity", text: "Read project files", at },
    { id: "a", role: "agent", text: "The original findings", at },
  ], receipts: ["original-receipt"] });
function fixture(job = original()) {
  const root = nativeVault({ files: { ".env": "OPENAI_API_KEY=sk-test-not-a-real-api-key\nBIGBRAIN_PILOT_ENABLED=true\n" } }); roots.push(root);
  writeAtomic(join(root, ".spool/work-sessions", `${job.id}.json`), JSON.stringify(job));
  const work = new WorkHistory(root);
  return { root, work, job };
}

test("legacy migration is durable, idempotent, quiet, and leaves the original history available", async () => {
  const { root, work, job } = fixture();
  let calls = 0;
  const chats = new PilotChats(root, { work, backend: () => { calls++; throw new Error("No execution during migration"); } });
  const id = migratedPilotId(job.id), s = chats.get(id);
  expect(s.messages.map(m => [m.role, m.text])).toEqual([["user", "Investigate the graph"], ["assistant", "The original findings"]]);
  expect(s.backend).toEqual(DEFAULT_PILOT_BACKEND);
  expect(s.legacyWork?.thread).toBe(job.thread);
  expect(s.access).toBeUndefined();
  expect(s.updated).toBe(at); expect(s.lastActivityAt).toBe(at);
  expect(readConversation(root, id).threadId).toBeUndefined();
  await chats.sweep(); await new Promise(resolve => setImmediate(resolve));
  expect(calls).toBe(0); expect(s.ingestions).toBeUndefined();
  const saved = JSON.parse(readFileSync(join(root, ".spool/work-sessions", `${job.id}.json`), "utf8"));
  expect(saved.messages).toEqual(job.messages); expect(saved.receipts).toEqual(job.receipts);
  expect(saved.migratedToPilot).toBe(id);
  expect("send" in work).toBe(false);
  chats.draft(id, "A new draft"); chats.close();
  const reopened = new PilotChats(root, { work });
  expect(reopened.list()).toHaveLength(1); expect(reopened.get(id).draft).toBe("A new draft");
  reopened.close();
});

test("graph and search coalesce old sources and links into one Pilot and keep output nodes", () => {
  const job = original();
  job.outputs = [{ id: "output", path: "sources/output", title: "Submitted findings", at, kind: "vault", status: "submitted" }];
  const s = pilotFromWork(job, DEFAULT_PILOT_BACKEND);
  const base = { nodes: [
    { id: "topic", path: "memory/topic", title: "Topic", group: "memory", degree: 1 },
    { id: "old-source", path: "sources/transcript", title: job.title, group: "source", degree: 1, from: "claude", sessionId: job.thread },
  ], edges: [{ source: "topic", target: "old-source" }], hash: "base" };
  // Historical aliases resolve directly through the migrated Pilot.
  {
    const graph = base;
    const view = withPilotChats(graph, [s], null)!;
    expect(view.nodes.filter(n => n.id === s.id)).toHaveLength(1);
    expect(view.nodes.filter(n => n.pilotPhase)).toHaveLength(1);
    expect(view.nodes.some(n => n.id === "output")).toBe(true);
    expect(view.edges.some(e => [e.source, e.target].includes(s.id) && [e.source, e.target].includes("output"))).toBe(true);
    for (const alias of [sessionPath(job.id), job.id, "sources/transcript", "old-source"]) {
      expect(canonicalGraphView(view.nodes, { selected: [alias], excluded: [] }).selected).toEqual([s.id]);
    }
  }
  const hits = [sessionPath(job.id), "sources/transcript"].map(path => ({ dir: "source", title: job.title, snippet: "", from: "claude-code", sessionId: job.thread, note: { path, name: job.title, size: 0, modified: 0 } }));
  expect(withPilotSearch(hits, [s], "remote-only match").map(h => h.note.path)).toEqual([s.id]);
});

test("a migrated conversation continues through the selected Pilot backend without replaying its worker", async () => {
  const { root, work, job } = fixture();
  const requests: any[] = [];
  const chats = new PilotChats(root, { work, graph: () => [{ id: "topic" }], fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const event = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Continued in Pilot" }] }] } };
    return new Response(`event: response\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  const id = migratedPilotId(job.id);
  chats.setBackend(id, { adapter: "pi", provider: "openai", model: "gpt-5.6-terra", reasoning: "low" });
  expect(requests).toHaveLength(0);
  chats.send(id, "Explain those findings"); await chats.settled(id);
  expect(chats.get(id).phase).toBe("answered");
  expect(chats.get(id).messages.at(-1)?.text).toBe("Continued in Pilot");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain("The original findings");
  expect(JSON.stringify(requests[0])).toContain("Explain those findings");
  expect(work.get(job.id).messages).toHaveLength(3);
  chats.close();
});

test("terminal-owned histories migrate without resuming their old process", () => {
  const { root, work, job } = fixture({ ...original(), status: "terminal" });
  const chats = new PilotChats(root, { work });
  try { expect(chats.list().some(s => s.legacyWork?.id === job.id)).toBe(true); }
  finally { chats.close(); }
});

for (const source of ["worker", "external"] as const) {
  test(`${source} archives survive history loading, conversion and restart`, () => {
    const job = original();
    if (source === "worker") job.worker = { archivedAt: at, operations: [] };
    else job.external = { archivedAt: at, adapter: "codex", connected: false, capabilities: { open: "resume", interrupt: false, followUp: true } };
    const { root, work } = fixture(job);
    const id = migratedPilotId(job.id);
    const chats = new PilotChats(root, { work });
    expect(chats.get(id).deactivatedAt).toBe(at);
    expect(work.get(job.id).worker).toBeUndefined();
    chats.close();
    const restarted = new PilotChats(root, { work: new WorkHistory(root) });
    expect(restarted.get(id).deactivatedAt).toBe(at);
    restarted.close();
  });
}

test("repair of an existing untouched conversion is durable and does not execute a turn", () => {
  const job = { ...original(), archivedAt: at };
  const { root, work } = fixture(job);
  const s = pilotFromWork(job, DEFAULT_PILOT_BACKEND);
  delete s.deactivatedAt; delete s.legacyWork!.archiveStateMigrated;
  writeAtomic(join(root, ".spool/pilot-chats", `${s.id}.json`), JSON.stringify(s));
  let calls = 0;
  const chats = new PilotChats(root, { work, backend: () => { calls++; throw new Error("Unexpected execution"); } });
  expect(chats.get(s.id).deactivatedAt).toBe(at);
  expect(chats.get(s.id).legacyWork?.archiveStateMigrated).toBe(true);
  expect(calls).toBe(0);
  chats.close();
  const restarted = new PilotChats(root, { work: new WorkHistory(root) });
  expect(restarted.get(s.id).deactivatedAt).toBe(at);
  restarted.close();
});

test("repair preserves subsequent activity, drafts, explicit archive choices, and ambiguous history", () => {
  for (const scenario of ["activity", "draft", "messages", "archived", "unknown"] as const) {
    const job = { ...original(), archivedAt: scenario === "unknown" ? undefined : at };
    const s = pilotFromWork(job, DEFAULT_PILOT_BACKEND);
    delete s.deactivatedAt; delete s.legacyWork!.archiveStateMigrated;
    const later = "2026-09-02T12:00:00.000Z";
    if (scenario === "activity") s.lastActivityAt = later;
    if (scenario === "draft") s.draft = "Continue later";
    if (scenario === "messages") s.messages.push({ id: "new", role: "user", text: "Continue", at: later });
    if (scenario === "archived") s.deactivatedAt = later;
    repairMigratedArchive(s, job);
    expect(s.deactivatedAt).toBe(scenario === "archived" ? later : undefined);
    expect(s.legacyWork?.archiveStateMigrated).toBe(true);
    // A later restart must not reconsider a completed repair decision.
    s.draft = ""; s.lastActivityAt = at; delete s.deactivatedAt;
    repairMigratedArchive(s, { ...job, archivedAt: at });
    expect(s.deactivatedAt).toBeUndefined();
  }
});
