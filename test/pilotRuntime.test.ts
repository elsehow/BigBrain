import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PilotChats } from "../lib/pilotChat";
import type { PilotBackendSetup } from "../lib/pilotBackend";
import { PILOT_RUNTIME } from "../lib/pilotRuntimeConfig";
import { readConversation } from "../lib/pilotConversation";
import { writeAtomic } from "../lib/fsx";
import type { PilotBackendTurn } from "../lib/pilotBackendTypes";
import { nativeVault } from "./support/vault";
import { creditsState } from "../lib/providerCredits";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const root = nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n", "memory/MEMORY.md": "Memory version one" } });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: { method: string; params: any }[] = [];
  let live = 0, peak = 0;
  const options = { graph: () => [], backend: (setup: PilotBackendSetup) => {
    live++; peak = Math.max(peak, live); let closed = false, prepared = false;
    let fresh = !setup.state.runtimeId;
    return {
      broken: false, transport: "subscription" as const,
      prepare: async () => { if (!prepared) { calls.push({ method: "prepare", params: {} }); prepared = true; } return true; },
      close: () => { if (!closed) { closed = true; live--; } },
      turn: async (args: PilotBackendTurn) => {
        if (closed) throw new Error("closed");
        calls.push({ method: fresh ? "session/start" : "session/resume", params: { id: setup.state.runtimeId } });
        setup.state.runtimeId ??= crypto.randomUUID(); setup.save();
        calls.push({ method: "turn/start", params: { input: [{ text: args.input(fresh) }] } });
        fresh = false; args.connected(); args.dispatched?.();
        return "Retained answer";
      },
    };
  } };
  const create = () => { const chats = new PilotChats(root, options); cleanup.push(() => chats.close()); return chats; };
  return { root, calls, create, live: () => live, peak: () => peak };
}
test("Pilot prewarms on create, sends only new messages, refreshes changed memory, and resumes after restart", async () => {
  const f = fixture(), chats = f.create(), s = chats.create([]);
  await tick();
  expect(f.calls.map(c => c.method)).toEqual(["prepare"]);
  chats.send(s.id, "First question"); await chats.settled(s.id);
  chats.send(s.id, "Second question"); await chats.settled(s.id);
  const inputs = () => f.calls.filter(c => c.method === "turn/start").map(c => c.params.input[0].text);
  expect(inputs()[0]).toContain("Memory version one");
  expect(inputs()[1]).not.toContain('"content":"First question"'); expect(inputs()[1]).not.toContain("Retained answer");
  expect(inputs()[1]).toContain("Second question"); expect(inputs()[1]).toContain("memory is unchanged");
  writeAtomic(join(f.root, "memory", "MEMORY.md"), "Memory version two");
  const id = readConversation(f.root, s.id).runtimeId;
  chats.close(); expect(f.live()).toBe(0);
  const restarted = f.create(); restarted.send(s.id, "Third question"); await restarted.settled(s.id);
  expect(inputs()[2]).toContain("Memory version two"); expect(inputs()[2]).not.toContain("Second question");
  expect(f.calls.filter(c => c.method === "session/start")).toHaveLength(1);
  expect(f.calls.find(c => c.method === "session/resume")!.params.id).toBe(id);
  expect(readConversation(f.root, s.id).through).toBe(6);
  expect(JSON.stringify(restarted.get(s.id))).not.toContain(id!);
});
test("empty drafts can disappear before warmup runs, without a process or stored provider thread", async () => {
  const f = fixture(), chats = f.create(), s = chats.create([]);
  chats.discard(s.id); await tick();
  expect(f.live()).toBe(0); expect(f.calls).toHaveLength(0);
});
test("warm process count is bounded, and closing a Pilot releases its process while retaining its thread", async () => {
  const f = fixture(), chats = f.create();
  for (let i = 0; i < PILOT_RUNTIME.maxWarmSessions + 2; i++) { chats.create([]); await tick(); }
  expect(f.live()).toBe(PILOT_RUNTIME.maxWarmSessions); expect(f.peak()).toBe(PILOT_RUNTIME.maxWarmSessions);
  expect(f.calls.some(c => c.method === "session/start")).toBe(false);
  const s = chats.create([]); chats.send(s.id, "Question"); await chats.settled(s.id);
  const thread = readConversation(f.root, s.id).runtimeId;
  chats.deactivate(s.id); expect(f.live()).toBe(PILOT_RUNTIME.maxWarmSessions - 1);
  expect(readConversation(f.root, s.id).runtimeId).toBe(thread);
  expect(chats.get(s.id).messages).toHaveLength(2);
});
test("a Pilot turn that runs out of usage credits raises the base's credits banner; a later answer clears it", async () => {
  const root = nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n" } });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let broke = true;
  const chats = new PilotChats(root, { graph: () => [], backend: () => ({
    broken: false, transport: "subscription" as const, prepare: async () => true, close: () => {},
    turn: async (args: PilotBackendTurn) => {
      args.connected(); args.dispatched?.();
      if (broke) throw new Error("Your credit balance is too low to access the Anthropic API.");
      return "Answer";
    },
  }) });
  cleanup.push(() => chats.close());
  const s = chats.create([]);
  chats.setBackend(s.id, { adapter: "pi", provider: "anthropic", model: "claude-sonnet-5-5", reasoning: "low" });
  chats.send(s.id, "Question"); await chats.settled(s.id);
  expect(creditsState(root).anthropic?.roles).toEqual(["pilot"]);
  expect(chats.get(s.id).error ?? JSON.stringify(chats.get(s.id))).toContain("Out of usage credits");
  broke = false;
  chats.send(s.id, "Again"); await chats.settled(s.id);
  expect(creditsState(root).anthropic).toBeUndefined();
});
