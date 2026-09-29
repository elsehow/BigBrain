import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PilotChats } from "./support/pilotSession";
import { PILOT_LIFECYCLE as timing } from "../lib/pilotLifecycleConfig";
import { landDrop } from "../lib/landItem";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nodes = [{ id: "arbor", path: "entities/arbor.md", title: "Arbor", group: "entity", degree: 0 }];
function fixture(land?: (content: string) => ReturnType<typeof landDrop>) {
  const root = nativeVault({ files: { ".env": "OPENAI_API_KEY=sk-test-only\nBIGBRAIN_PILOT_ENABLED=true\n" } }); roots.push(root);
  let clock = Date.parse("2026-09-14T00:00:00Z");
  const options = { now: () => clock, graph: () => nodes, land, fetch: (async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "An answer." }] }] } })}\n\n`)) as typeof fetch };
  const chats = new PilotChats(root, options);
  const s = chats.create(["arbor"]);
  const answer = async (text = "First question") => { chats.send(s.id, text); await chats.settled(s.id); };
  return { root, chats, s, options, answer, advance: (ms: number) => { clock += ms; } };
}
test("dormancy uses semantic activity, with exact discoverable timing boundaries", async () => {
  const f = fixture(); await f.answer(); const activity = f.s.lastActivityAt;
  expect(timing.dormantAfterMs).toBe(600_000); expect(timing.ingestAfterMs).toBe(86_400_000);
  f.advance(timing.dormantAfterMs - 1); f.chats.draft(f.s.id, ""); f.chats.list(); await f.chats.sweep();
  expect(f.s.lifecycle).toBe("active"); expect(f.s.lastActivityAt).toBe(activity);
  f.advance(1); await f.chats.sweep(); expect(f.s.lifecycle).toBe("dormant");
  expect(f.s.lastActivityAt).toBe(activity); expect(f.s.updated).not.toBe(activity);
  expect(withPilotChats({ nodes, edges: [] }, [f.s], null)!.nodes.find(n => n.id === f.s.id)!.pilotPhase).toBe("answered");
});
test("24-hour ingestion is durable, incremental, and retains context and one graph identity", async () => {
  const f = fixture(); await f.answer(); f.advance(timing.ingestAfterMs - 1); await f.chats.sweep();
  expect(readSourceInsertionLog(f.root)).toHaveLength(0);
  f.advance(1); await Promise.all([f.chats.sweep(), f.chats.sweep()]);
  expect(f.s.lifecycle).toBe("ingested"); expect(f.s.ingestedMessages).toBe(2);
  const first = readSourceInsertionLog(f.root)[0]!;
  expect(first.envelope.key).toBe(f.s.id); expect(first.envelope.pilot_seed).toEqual(["arbor"]); expect(first.envelope.pilot_context).toEqual(["arbor"]);
  const restored = new PilotChats(f.root, f.options); await restored.sweep(); expect(readSourceInsertionLog(f.root)).toHaveLength(1);
  f.chats.presence("test-client-one", f.s.id); expect(f.s.lifecycle).toBe("ingested");
  await f.answer("Second question"); f.chats.presence("test-client-one", null); f.advance(timing.ingestAfterMs); await f.chats.sweep();
  const events = readSourceInsertionLog(f.root); expect(events).toHaveLength(2); expect(f.s.ingestedMessages).toBe(4);
  const latest = f.s.ingestions!.at(-1)!;
  const body = events.find(e => e.id === latest.insertionId)!.body;
  expect(body).toContain("user: Second question"); expect(body).not.toContain("user: First question");
  const captured = f.s.ingestions!.map(r => ({ id: `source:${r.insertionId}`, path: r.path, title: "Chapter", group: "source", degree: 1, from: "pilot", sessionId: f.s.id }));
  const graph = withPilotChats({ nodes: [...nodes, ...captured], edges: captured.map(n => ({ source: n.id, target: "arbor" })) }, [f.s], null)!;
  expect(graph.nodes).toHaveLength(2); expect(graph.nodes.find(n => n.id === f.s.id)!.sourcePaths).toContain(latest.path);
  expect(graph.edges).toHaveLength(1); expect(graph.nodes.find(n => n.id === f.s.id)!.pilotPhase).toBe("answered");
  expect(withPilotChats(graph, [f.s], f.s.id)!.nodes.find(n => n.id === f.s.id)!.pilotPhase).toBe("answered");
});
test("working turns and unsent drafts do not age or ingest", async () => {
  const f = fixture(); await f.answer(); f.s.phase = "working"; f.advance(timing.ingestAfterMs); await f.chats.sweep();
  expect(f.s.lifecycle).toBe("active"); expect(f.s.ingestions).toBeUndefined();
  f.s.phase = "answered"; f.chats.draft(f.s.id, "Unsent follow-up"); f.advance(timing.ingestAfterMs); await f.chats.sweep();
  expect(f.s.lifecycle).toBe("active"); expect(f.s.ingestions).toBeUndefined();
  const draft = f.chats.create([]); f.chats.draft(draft.id, "Keep this draft"); f.advance(timing.ingestAfterMs); await f.chats.sweep(); expect(draft.lifecycle).toBe("active");
});
test("composer heartbeats protect open tabs without changing activity; expired leases recover", async () => {
  const f = fixture(); await f.answer(); f.chats.presence("test-client-one", f.s.id); const activity = f.s.lastActivityAt;
  for (let i = 0; i < 1440; i++) { f.advance(60_000); f.chats.presence("test-client-one", f.s.id); }
  await f.chats.sweep(); expect(f.s.lastActivityAt).toBe(activity); expect(f.s.lifecycle).toBe("dormant");
  // The persisted lease survives an engine restart while the tab reconnects.
  const restored = new PilotChats(f.root, f.options); await restored.sweep(); expect(restored.get(f.s.id).lifecycle).toBe("dormant");
  f.advance(timing.composerLeaseMs); await restored.sweep(); expect(restored.get(f.s.id).lifecycle).toBe("ingested");
// A simulated day of minute heartbeats is 1,440 real session writes: a loaded CI
// runner needs more than bun's 5s default (it took 5.7s there), not fewer heartbeats.
}, 30_000);
test("closing one composer cannot clear a second tab's lease", async () => {
  const f = fixture(); await f.answer(); f.chats.presence("test-client-one", f.s.id); f.chats.presence("test-client-two", f.s.id);
  f.chats.presence("test-client-one", null); expect(f.s.composerLeaseUntil).toBeGreaterThan(Date.parse(f.s.lastActivityAt!));
  f.chats.presence("test-client-two", null); expect(f.s.composerLeaseUntil).toBe(0);
});
test("a crash after landing retries identical chapter bytes without duplicating evidence", async () => {
  let root = "", fail = true; const bodies: string[] = [];
  const f = fixture(async content => { bodies.push(content); const receipt = await landDrop({ root, content }); if (fail) { fail = false; throw new Error("lost receipt"); } return receipt; }); root = f.root;
  await f.answer(); f.advance(timing.ingestAfterMs); await f.chats.sweep();
  expect(f.s.pendingIngestion).toBeDefined(); expect(f.s.ingestionError).toBeTruthy(); expect(readSourceInsertionLog(root)).toHaveLength(1);
  f.advance(60_000); const restored = new PilotChats(root, f.options); await restored.sweep();
  expect(bodies[0]).toBe(bodies[1]); expect(readSourceInsertionLog(root)).toHaveLength(1);
  expect(restored.get(f.s.id).lifecycle).toBe("ingested"); expect(restored.get(f.s.id).ingestionError).toBeUndefined();
});
test("resuming while an old chapter lands cannot archive the resumed session", async () => {
  let release!: () => void; const pending = new Promise<void>(r => release = r);
  const f = fixture(async () => { await pending; return { id: "source", insertionId: "ins_test", path: "log/insertions/test.json", deduped: false }; });
  await f.answer(); f.advance(timing.ingestAfterMs); const sweep = f.chats.sweep();
  f.chats.presence("test-client-one", f.s.id); await f.answer("New question"); release(); await sweep;
  expect(f.s.lifecycle).toBe("active"); expect(f.s.ingestedMessages).toBe(2); expect(f.s.messages).toHaveLength(4);
});
test("optimistic session identity can be retried without creating another node", () => {
  const f = fixture(), id = `pilot-${"a".repeat(32)}`;
  const first = f.chats.create(["entities/arbor.md"], id);
  expect(f.chats.create(["arbor"], id)).toBe(first);
  expect(() => f.chats.create([], id)).toThrow("different context");
});

test("abandoned empty sessions expire, but open composers and typed drafts survive", async () => {
  const f = fixture();
  const typed = f.chats.create([]); f.chats.draft(typed.id, "Keep this draft");
  const open = f.chats.create([]); f.chats.presence("open-client-one", open.id);
  f.advance(timing.abandonedDraftAfterMs - 1); await f.chats.sweep();
  expect(f.chats.list().some(s => s.id === f.s.id)).toBe(true);
  f.chats.presence("open-client-one", open.id);
  f.advance(1); await f.chats.sweep();
  expect(f.chats.list().some(s => s.id === f.s.id)).toBe(false);
  expect(f.chats.get(typed.id).draft).toBe("Keep this draft");
  expect(f.chats.get(open.id).phase).toBe("draft");
  const restored = new PilotChats(f.root, f.options);
  expect(restored.list().some(s => s.id === f.s.id)).toBe(false);
  f.advance(timing.composerLeaseMs); await restored.sweep();
  expect(restored.list().some(s => s.id === open.id)).toBe(false);
  expect(restored.get(typed.id).draft).toBe("Keep this draft");
});

test("discard never removes conversation content even if the phase is draft", async () => {
  const f = fixture(); await f.answer(); f.s.phase = "draft";
  expect(() => f.chats.discard(f.s.id)).toThrow("Only an empty draft");
  f.advance(timing.abandonedDraftAfterMs); await f.chats.sweep();
  expect(f.chats.get(f.s.id).messages).toHaveLength(2);
});

test("explicit deactivation preserves the session and defeats late composer heartbeats", async () => {
  const f = fixture(); await f.answer(); f.chats.draft(f.s.id, "Unsent follow-up");
  f.chats.presence("test-client-one", f.s.id);
  const messages = [...f.s.messages], context = [...f.s.context];
  f.chats.deactivate(f.s.id);
  f.chats.presence("test-client-one", f.s.id); f.chats.presence("test-client-one", null);
  expect(f.s.lifecycle).toBe("dormant"); expect(f.s.deactivatedAt).toBeTruthy();
  expect(f.s.messages).toEqual(messages); expect(f.s.context).toEqual(context); expect(f.s.draft).toBe("Unsent follow-up");
  const view = withPilotChats({ nodes, edges: [] }, [f.s], null)!;
  expect(view.nodes.find(n => n.id === f.s.id)!.group).toBe("source");
  expect(view.nodes.find(n => n.id === f.s.id)!.pilotPhase).toBe("idle");
  const restored = new PilotChats(f.root, f.options);
  expect(restored.get(f.s.id).lifecycle).toBe("dormant");
  restored.presence("test-client-new", f.s.id);
  expect(restored.get(f.s.id).lifecycle).toBe("dormant"); expect(restored.get(f.s.id).deactivatedAt).toBeTruthy();
  restored.send(f.s.id, "Continue"); await restored.settled(f.s.id);
  expect(restored.get(f.s.id).lifecycle).toBe("active"); expect(restored.get(f.s.id).deactivatedAt).toBeUndefined();
});

test("explicitly closed empty sessions survive automatic empty-draft cleanup", async () => {
  const f = fixture(); f.chats.deactivate(f.s.id); f.advance(timing.ingestAfterMs); await f.chats.sweep();
  expect(f.chats.get(f.s.id).lifecycle).toBe("dormant");
  expect(f.chats.get(f.s.id).messages).toEqual([]);
  expect(() => f.chats.discard(f.s.id)).toThrow("Only an empty draft");
});

test("deactivating a running turn stays dormant after abort completion", async () => {
  const f = fixture();
  const chats = new PilotChats(f.root, { ...f.options, fetch: ((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  })) as typeof fetch });
  chats.send(f.s.id, "Find context"); chats.deactivate(f.s.id); await chats.settled(f.s.id);
  const closed = chats.get(f.s.id);
  expect(closed.phase).toBe("interrupted"); expect(closed.lifecycle).toBe("dormant"); expect(closed.deactivatedAt).toBeTruthy();
  expect(closed.messages[0]!.text).toBe("Find context");
});

test("selecting and leaving an idle agent does not reactivate it; sending does", async () => {
  const f = fixture(); await f.answer(); f.advance(timing.dormantAfterMs); await f.chats.sweep();
  const activity = f.s.lastActivityAt;
  f.chats.presence("test-client-one", f.s.id);
  expect(f.s.lifecycle).toBe("dormant"); expect(f.s.lastActivityAt).toBe(activity);
  f.chats.presence("test-client-one", null);
  expect(f.s.lifecycle).toBe("dormant"); expect(f.s.lastActivityAt).toBe(activity);
  await f.answer("Follow-up"); expect(f.s.lifecycle).toBe("active");
});
