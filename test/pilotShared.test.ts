import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./support/vault";
import { PilotChats } from "./support/pilotSession";
import { readConversation, saveConversation, refreshPilotContract } from "../lib/pilotConversation";
import { pilotSession } from "../lib/pilot";
import { AGENT_STATES, agentGlyph, agentVisualState } from "../web/ui/src/lib/agentAppearance";
const roots: string[] = [], services: { close(): void }[] = [];
afterEach(() => { services.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function vault() { const root = nativeVault({ files: { ".env": "OPENAI_API_KEY=sk-not-a-real-api-key\nBIGBRAIN_PILOT_ENABLED=true\n" } }); roots.push(root); return root; }
const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (name: string, args: unknown) => ({ type: "function_call", call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
function scripted(outputs: unknown[][], requests: any[] = []) {
  return (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: outputs.shift() ?? [message("Done")] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
function chats(root: string, options: ConstructorParameters<typeof PilotChats>[1]) { const s = new PilotChats(root, { graph: () => [], ...options }); services.push(s); return s; }
test("a damaged receipt leaves unrelated Pilot turns usable and describes history as incomplete", async () => {
  const root = vault(), requests: any[] = [];
  const service = chats(root, { fetch: scripted([[message("Available despite incomplete history.")]], requests) });
  const damaged = service.create([]), other = service.create([]);
  await service.actions.execute({ actor: { kind: "pilot", id: damaged.id }, request: "synthetic-action", operation: "drop", scope: [], payload: {} }, { authorize() {}, execute: () => ({ saved: true }) });
  const receipt = service.actions.list({ kind: "pilot", id: damaged.id }).receipts[0]!;
  writeFileSync(join(root, ".spool", "application-actions", receipt.id + ".json"), "{damaged");
  service.submit(other.id, "Continue the discussion", { id: "synthetic-input", mode: "text" });
  await service.settled(other.id);
  expect(other.phase).toBe("answered");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain('\\"complete\\":false');
  expect(JSON.stringify(requests[0])).toContain("Missing results do not establish that an action did not happen");
  expect(service.actionReceipts(other.id)).toMatchObject({ complete: false, receipts: [], issues: [{ kind: "receipt", count: 1 }] });
});
test("legacy Pilot threads upgrade once without losing history, evidence, or action receipts", async () => {
  const root = vault();
  const old = chats(root, {}), session = old.create([]);
  session.messages.push({ id: "previous-user", role: "user", text: "Previously requested task", at: session.created },
    { id: "previous-answer", role: "assistant", text: "Previously confirmed result", at: session.created });
  session.backend = { adapter: "codex", model: "gpt-5.6-terra", reasoning: "low" };
  old.draft(session.id, "Keep this draft"); old.close();
  const evidence = [{ tool: "read_note", args: { path: "memory/project" }, result: { text: "Saved project evidence" } }];
  const actions = { completed: { status: "done" as const, result: { id: "existing-worker" } }, uncertain: { status: "pending" as const } };
  saveConversation(root, session.id, { threadId: "old-read-only-thread", through: 2, memory: "old memory", evidence, actions });
  const setups: any[] = [], inputs: string[] = [];
  const backend = ((setup: any) => {
    setups.push(setup);
    return { broken: false, transport: "subscription", prepare: async () => true, close() {}, async turn(args: any) {
      inputs.push(args.input(!setup.state.runtimeId));
      setup.state.runtimeId = "upgraded-thread"; setup.save(); args.connected(); args.dispatched?.(); return "Current capabilities available";
    } } as any;
  });
  const upgraded = chats(root, { backend });
  expect(inputs).toEqual([]); // Opening/migrating never replays a user action.
  expect(upgraded.get(session.id).draft).toBe("Keep this draft");
  upgraded.submit(session.id, "What can you do now?", { id: "new-input", mode: "text" }); await upgraded.settled(session.id);
  expect(setups[0].state.threadId).toBeUndefined();
  expect(setups[0].tools.map((t: any) => t.name)).not.toContain("start_work");
  expect(setups[0].instructions).toContain("You cannot launch agents");
  expect(setups[0].interactive).toBe(false);
  expect(inputs[0]).toContain("Previously confirmed result"); expect(inputs[0]).toContain("Saved project evidence");
  const saved = readConversation(root, session.id);
  expect(saved.runtimeId).toBe("upgraded-thread"); expect(saved.previousThreadIds).toBeUndefined();
  expect(saved.evidence).toEqual(evidence); expect(saved.actions).toEqual(actions); expect(saved.runtimeSignature).toBeTruthy();
  const recency = upgraded.get(session.id).lastActivityAt; upgraded.close();
  const resumed = chats(root, { backend });
  expect(resumed.get(session.id).lastActivityAt).toBe(recency);
  resumed.submit(session.id, "Continue", { id: "follow-up", mode: "voice" }); await resumed.settled(session.id);
  expect(setups.at(-1).state.runtimeId).toBe("upgraded-thread"); expect(inputs).toHaveLength(2);
  expect(resumed.get(session.id).messages).toHaveLength(6);
});
test("saved Responses state discards private continuation but preserves evidence and receipts", () => {
  const root = vault(), id = "legacy";
  const evidence = [{ tool: "read_note", args: { path: "memory/example" }, result: { text: "Evidence" } }];
  const actions = { done: { status: "done" as const, result: "Saved" }, pending: { status: "pending" as const } };
  const legacy = { through: 2, memory: "old", evidence, actions,
    apiTurns: [[{ type: "function_call", name: "drop", arguments: "{}" }]] };
  saveConversation(root, id, legacy);
  const state = readConversation(root, id);
  expect(state.through).toBe(0); expect(state.memory).toBeUndefined();
  expect(state).not.toHaveProperty("apiTurns");
  expect(state.evidence).toEqual(evidence); expect(state.actions).toEqual(actions);
  expect(refreshPilotContract(state, "current")).toBe(true);
  expect(refreshPilotContract(state, "current")).toBe(false);
});
test("voice and text share evidence, model, canonical messages and idempotency after restart", async () => {
  const root = vault(), requests: any[] = [];
  const s = chats(root, { fetch: scripted([[call("read_note", { path: "memory/arbor" })], [message("Evidence says uncertain.")], [message("Same conclusion.")]], requests), tool: async () => ({ text: "Distinct retained source evidence" }) });
  const session = s.create([]);
  s.submit(session.id, "Read Arbor", { id: "voice-input-1", mode: "voice" }); await s.settled(session.id);
  s.submit(session.id, "Read Arbor", { id: "voice-input-1", mode: "voice" }); expect(requests).toHaveLength(2);
  s.recordSpoken(session.id, { id: "speech-receipt-1", message: session.messages[1]!.id, text: "Evidence says uncertain.", status: "interrupted" });
  expect(session.phase).toBe("answered");
  s.submit(session.id, "Why uncertain?", { id: "text-input-1", mode: "text" }); await s.settled(session.id);
  expect(JSON.stringify(requests[2].input)).toContain("Distinct retained source evidence");
  expect(requests.every(r => r.model === session.backend?.model)).toBe(true);
  expect(session.messages[1]!.replyTo).toBe(session.inputs![0]!.message);
  const recency = session.lastActivityAt; s.close();
  const recovered = chats(root, { fetch: scripted([]) });
  const saved = recovered.submit(session.id, "Read Arbor", { id: "voice-input-1", mode: "text" });
  expect(saved.messages).toHaveLength(4); expect(saved.spoken).toHaveLength(1); expect(saved.lastActivityAt).toBe(recency);
  expect(() => recovered.submit(session.id, "Different", { id: "voice-input-1", mode: "text" })).toThrow("different message");
});
test("mutating calls are not repeated within a turn, even with different call IDs", async () => {
  let writes = 0; const root = vault();
  const s = chats(root, { tool: async () => { writes++; return { id: "saved" }; }, fetch: scripted([
    [call("drop", { title: "A", body: "B" }), call("drop", { body: "B", title: "A" })], [message("Saved.")],
  ]) }); const parent = s.create([]);
  s.submit(parent.id, "Save this", { id: "save-input", mode: "voice" }); await s.settled(parent.id);
  expect(writes).toBe(1);
  expect(readConversation(root, parent.id).actions).toBeUndefined();
  expect(s.actions.list({ kind: "pilot", id: parent.id }).receipts).toMatchObject([{ status: "completed", result: { id: "saved" }, operation: "drop" }]);
  s.setBackend(parent.id, { adapter: "pi", provider: "openai", model: "another-model", reasoning: "off" });
  expect(s.actionReceipts(parent.id).receipts).toMatchObject([{ status: "completed", operation: "drop" }]);
  s.close();
  const restarted = new PilotChats(root, { categories: false });
  expect(restarted.actionReceipts(parent.id).receipts).toMatchObject([{ status: "completed", operation: "drop" }]);
  restarted.close();
});
test("unsupported adapters fail explicitly; changing models retains evidence and removes native continuation", async () => {
  const root = vault(), s = chats(root, { tool: async () => ({ fact: "kept" }), fetch: scripted([[call("read_note", { path: "a" })], [message("Read.")]]) });
  const parent = s.create([]); s.send(parent.id, "Read"); await s.settled(parent.id);
  expect(() => s.setBackend(parent.id, { adapter: "unknown", model: "x" })).toThrow("Unsupported");
  s.setBackend(parent.id, { adapter: "pi", provider: "openai", model: "another-model", reasoning: "off" });
  expect(parent.messages).toHaveLength(2); expect(readConversation(root, parent.id).evidence?.[0]?.result).toEqual({ fact: "kept" });
  expect(readConversation(root, parent.id).through).toBe(0);
  expect((pilotSession() as any).tools).toEqual([]); expect((pilotSession() as any).tool_choice).toBe("none");
});
test("agent geometry matches Search List States independently of Pilot phases", () => {
  expect(AGENT_STATES).toEqual(["running", "waiting", "done", "stopped"]);
  expect(agentGlyph("running").spin).toBe(true); expect(agentGlyph("running", true).inverted).toBe(true);
  expect(agentGlyph("waiting").pulse).toBe(true);
  expect(agentGlyph("done")).toMatchObject({ active: true, live: false, outer: false });
  expect(agentGlyph("stopped")).toMatchObject({ active: false, live: false, outer: false });
  for (const state of ["done", "stopped"] as const) expect(agentGlyph(state, true).outer).toBe(true);
  expect(agentVisualState({ status: "failed" })).toBe("stopped");
});
test("queued cross-mode input is durable, deduplicated, and requires explicit resume after cancellation/restart", async () => {
  const root = vault(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), blocked = new Promise<void>(r => release = r);
  const s = chats(root, { fetch: scripted([[call("read_note", { path: "a" })], [message("Do not commit late")]]),
    tool: async () => { enter(); await blocked; return { fact: "late" }; } });
  const parent = s.create([]);
  s.submit(parent.id, "First request", { id: "first-request", mode: "text" }); await entered;
  s.draft(parent.id, "Spoken correction");
  s.submit(parent.id, "Spoken correction", { id: "queued-correction", mode: "voice" });
  expect(parent.draft).toBe("");
  s.submit(parent.id, "Spoken correction", { id: "queued-correction", mode: "voice" });
  expect(parent.pendingInputs).toHaveLength(1);
  expect(() => s.setBackend(parent.id, { adapter: "pi", provider: "openai", model: "different" })).toThrow("current turn");
  s.draft(parent.id, "Unsent next thought");
  s.stop(parent.id); release(); await s.settled(parent.id); s.close();
  const requests: any[] = [], recovered = chats(root, { fetch: scripted([[message("Correction applied.")]], requests) });
  expect(requests).toHaveLength(0); expect(recovered.get(parent.id).pendingInputs).toHaveLength(1);
  recovered.resumeInputs(parent.id); await recovered.settled(parent.id);
  expect(recovered.get(parent.id).draft).toBe("Unsent next thought");
  expect(recovered.get(parent.id).inputs?.filter(i => i.id === "queued-correction")).toHaveLength(1);
  expect(requests).toHaveLength(1);
});
test("an unavailable selected subscription never silently executes an API fallback", async () => {
  const root = vault(); let apiCalls = 0;
  const s = chats(root, { fetch: (async () => { apiCalls++; throw Error("must not fall back"); }) as typeof fetch,
    backend: () => ({ broken: false, transport: "subscription", prepare: async () => false, turn: async () => null, close() {} }) as any });
  const parent = s.create([]); s.setBackend(parent.id, { adapter: "pi", provider: "openai-codex", model: "requested-model" });
  s.send(parent.id, "Answer"); await s.settled(parent.id);
  expect(parent.phase).toBe("failed"); expect(parent.error).toContain("selected Pilot backend"); expect(apiCalls).toBe(0);
});
test("voice disabled does not disable the shared text backend", async () => {
  const root = nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=false\nOPENAI_API_KEY=sk-fixture\n" } }); roots.push(root);
  const s = chats(root, { fetch: scripted([[message("Text still works.")]]) }), parent = s.create([]);
  s.submit(parent.id, "Typed request", { id: "voice-off-text", mode: "text" }); await s.settled(parent.id);
  expect(parent.phase).toBe("answered");
});
test("Pilot notifications are explicit, bound to their creator, deduplicated and durable", async () => {
  const root = vault();
  const s = chats(root, { fetch: scripted([
    [call("notify_user", { key: "date-choice", kind: "question", text: "Thursday or Friday?", pilotId: "spoofed" })],
    [call("notify_user", { key: "date-choice", kind: "question", text: "Thursday or Friday?" })],
    [message("I need your date choice.")],
  ]) });
  const parent = s.create([]); s.send(parent.id, "Plan the meeting"); await s.settled(parent.id);
  const [n] = s.notifications(); expect(s.notifications()).toHaveLength(1);
  expect(n!.pilotId).toBe(parent.id);
  expect(parent.messages.find(m => m.id === n!.messageId)?.text).toBe(n!.text);
  s.notificationState(n!.id, "seen");
  s.notificationState(n!.id, "unseen");
  expect(s.notifications()[0]).toMatchObject({ seen: false, dismissed: false, resolved: false });
  s.notificationState(n!.id, "seen"); s.notificationState(n!.id, "dismiss");
  expect(s.notifications()[0]).toMatchObject({ seen: true, dismissed: true, resolved: false });
  s.close();
  const restarted = chats(root, { fetch: scripted([[message("Thursday it is.")]]) });
  expect(restarted.notifications()[0]).toMatchObject({ id: n!.id, seen: true, dismissed: true, resolved: false });
  const input = { id: "notification-answer-1", mode: "text" as const, notificationId: n!.id };
  restarted.submit(parent.id, "Thursday", input); await restarted.settled(parent.id);
  expect(restarted.notifications()[0]!.resolved).toBe(true);
  expect(() => restarted.notificationState(n!.id, "unseen")).toThrow("subsequent turn");
  const count = restarted.get(parent.id).messages.length;
  restarted.submit(parent.id, "Thursday", input);
  expect(restarted.get(parent.id).messages).toHaveLength(count);
  expect(() => restarted.submit(parent.id, "Friday", { ...input, id: "different-answer-id" })).toThrow("no longer");
  expect(() => restarted.submit(parent.id, "Thursday", { ...input, notificationId: "different" })).toThrow("different message");
});

test("a different Pilot cannot answer or resolve another Pilot's notification", async () => {
  const root = vault(), s = chats(root, { fetch: scripted([
    [call("notify_user", { key: "question", kind: "question", text: "Which dataset?" })], [message("Waiting")],
  ]) });
  const a = s.create([]); s.send(a.id, "Check datasets"); await s.settled(a.id);
  const n = s.notifications()[0]!; const b = s.create([]);
  expect(() => s.submit(b.id, "Dataset A", { id: "cross-pilot-input", mode: "text", notificationId: n.id })).toThrow("no longer");
  await (s as any).executeTool(b, "resolve_notification", { id: n.id }, new AbortController().signal);
  expect(s.notifications()[0]!.resolved).toBe(false);
});

test("queued notification replies keep their question identity across restart", async () => {
  const root = vault(); let requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = scripted([[call("notify_user", { key: "date", kind: "question", text: "Which date?" })], [message("Waiting")]]);
  const s = chats(root, { fetch: (async (...args: Parameters<typeof fetch>) => { if (++requests > 1) await gate; return fake(...args); }) as typeof fetch });
  const parent = s.create([]); s.send(parent.id, "Plan dates");
  for (let i = 0; i < 100 && !s.notifications().length; i++) await Bun.sleep(1);
  const n = s.notifications()[0]!;
  expect(n).toBeDefined();
  const input = { id: "queued-notification-answer", mode: "text" as const, notificationId: n.id };
  s.submit(parent.id, "Friday", input); s.submit(parent.id, "Friday", input);
  expect(parent.pendingInputs).toHaveLength(1);
  expect(s.notifications()[0]!.resolved).toBe(true);
  s.close(); release(); await s.settled(parent.id);
  const restarted = chats(root, { fetch: scripted([[message("Friday confirmed")]]) });
  expect(restarted.get(parent.id).pendingInputs?.[0]?.notificationId).toBe(n.id);
  expect(restarted.notifications()[0]!.resolved).toBe(true);
  restarted.submit(parent.id, "Friday", input);
  expect(restarted.get(parent.id).pendingInputs).toHaveLength(1);
  restarted.resumeInputs(parent.id); await restarted.settled(parent.id);
  expect(restarted.get(parent.id).inputs?.find(i => i.id === input.id)?.notificationId).toBe(n.id);
});

test("large unread selections can seed a Pilot without truncation", () => {
  const nodes = Array.from({ length: 105 }, (_, i) => ({ id: `mail-${i}`, path: `references/mail-${i}.md`, title: `Mail ${i}` }));
  const s = chats(vault(), { graph: () => nodes, fetch: scripted([]) });
  expect(s.create(nodes.map(n => n.id)).context).toHaveLength(105);
});

test("a normal follow-up clears existing notifications and prevents marking them unread", async () => {
  const root = vault();
  const s = chats(root, { fetch: scripted([
    [call("notify_user", { key: "choice", kind: "question", text: "Which date?" })],
    [message("Waiting for a date.")],
    [message("Understood.")],
  ]) });
  const parent = s.create([]); s.send(parent.id, "Plan it"); await s.settled(parent.id);
  const notice = s.notifications()[0]!;
  s.submit(parent.id, "Use Thursday", { id: "ordinary-follow-up", mode: "text" });
  await s.settled(parent.id);
  expect(s.notifications()[0]).toMatchObject({ seen: true, resolved: true });
  expect(() => s.notificationState(notice.id, "unseen")).toThrow("subsequent turn");
  s.close();
  const restarted = chats(root, {});
  expect(restarted.notifications()[0]).toMatchObject({ seen: true, resolved: true });
});

test("saved Codex defaults migrate to Pi, while new Codex selections are rejected", async () => {
  const { writeEnvValues, readEnvValues } = await import("../lib/envFile");
  const root = vault();
  const legacy = { adapter: "codex", model: "requested-model", reasoning: "high" };
  writeEnvValues(root, { BIGBRAIN_PILOT_BACKEND: JSON.stringify(legacy) });
  const s = chats(root, { backend: () => ({ broken: false, transport: "subscription", prepare: async () => true, turn: async () => "Ready", close() {} }) });
  expect(s.defaultBackend()).toEqual({ ...legacy, adapter: "pi", provider: "openai-codex" });
  expect(() => s.setDefaultBackend(legacy)).toThrow("Unsupported model adapter");
  expect(JSON.parse(readEnvValues(root).BIGBRAIN_PILOT_BACKEND!)).toEqual(legacy);
});

test("Responses choices migrate only at saved-state boundaries", async () => {
  const { readModelChoice, validateModelChoice } = await import("../lib/modelChoice");
  const { migratePilotBackend } = await import("../lib/pilotBackendTypes");
  const old = { adapter: "responses", model: "gpt-5.6-terra", reasoning: "none" };
  const expected = { adapter: "pi", provider: "openai", model: old.model, reasoning: "off" };
  expect(readModelChoice(old)).toEqual(expected);
  expect(migratePilotBackend(old)).toEqual(expected);
  expect(() => validateModelChoice(old)).toThrow("Unsupported");
});
