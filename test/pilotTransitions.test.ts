import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { newPilotChatSession, type PilotChatSession } from "../lib/pilotChatTypes";
import { transitionPilot, type PilotEvent } from "../lib/pilotTransitions";
import { PilotChats } from "../lib/pilotChat";
import type { ModelSessionTurn } from "../lib/run/session";
import { nativeVault } from "./support/vault";
import { PILOT_LIFECYCLE } from "../lib/pilotLifecycleConfig";

const at = "2026-09-26T12:00:00.000Z";
const id = `pilot-${"a".repeat(32)}`;
const input = (n: number): PilotEvent => ({ kind: "input", input: { id: `input-${n}`, text: `Question ${n}`, mode: "text" }, message: `m${n}`, turn: `t${n}`, at, queue: true });
const step = (s: PilotChatSession, e: PilotEvent) => transitionPilot(s, e).state;

// Cancellation, duplicate/restart and deactivation traces live in applicationScenarios.test.ts
// and are rendered by the sidebar workbench from the same inputs.

test("publication receipts are scoped to their chapter and cannot archive resumed activity", () => {
  let s = step(newPilotChatSession([], id, at), input(1));
  s = step(s, { kind: "message", turn: "t1", message: { id: "answer", role: "assistant", text: "Answer", at } });
  s = step(s, { kind: "settled", turn: "t1", outcome: "answered", at, advance: false });
  const later = new Date(Date.parse(at) + PILOT_LIFECYCLE.ingestAfterMs).toISOString();
  const aging = transitionPilot(s, { kind: "age", at: later, blocked: false });
  const effect = aging.effects.find(e => e.kind === "publish")!;
  if (effect.kind !== "publish") throw Error("Expected publication");
  s = step(aging.state, { ...input(2), at: later } as PilotEvent);
  const published: PilotEvent = { kind: "published", chapter: effect.chapter, activity: effect.activity, receipt: { id: "source-1", insertionId: "ins-1", path: "log/insertions/test.json" } };
  s = step(s, published);
  expect(s.lifecycle).toBe("active");
  expect(s.turn?.id).toBe("t2");
  expect(s.ingestedMessages).toBe(2);
  expect(step(s, published)).toBe(s);
});

const resources: { root: string; chats: PilotChats }[] = [];
afterEach(() => { for (const { root, chats } of resources.splice(0)) { chats.close(); rmSync(root, { recursive: true, force: true }); } });
function controlled() {
  const root = nativeVault();
  const calls: { args: ModelSessionTurn; complete: (text: string) => void }[] = [];
  const chats = new PilotChats(root, { categories: false, graph: () => [], now: () => Date.parse(at), backend: () => ({
    broken: false, transport: "subscription", prepare: async () => true, close() {},
    turn: args => new Promise<string>(complete => { calls.push({ args, complete }); }),
  }) });
  resources.push({ root, chats });
  return { root, chats, calls, s: chats.create([]) };
}

test("production Pilot ignores stale callbacks after cancellation and a resumed turn", async () => {
  const f = controlled();
  f.chats.send(f.s.id, "First");
  const old = f.calls[0]!;
  f.chats.submit(f.s.id, "Follow-up", { id: "follow-up-001", mode: "text" });
  f.chats.stop(f.s.id);
  expect(() => f.chats.submit(f.s.id, "Too early", { id: "too-early-001", mode: "text" })).toThrow("stopping");
  old.args.delta("Late text"); old.complete("Late answer");
  await f.chats.settled(f.s.id);
  expect(f.s.phase).toBe("interrupted");
  expect(f.s.messages.map(m => m.text)).toEqual(["First"]);
  f.chats.resumeInputs(f.s.id);
  old.args.event?.("assistantMessage", { id: "late", text: "Late message" });
  old.args.connected(); old.args.dispatched?.(); old.args.delta("More late text");
  expect(f.s.live).toBe("");
  f.calls[1]!.complete("Current answer"); await f.chats.settled(f.s.id);
  expect(f.s.messages.map(m => m.text)).toEqual(["First", "Follow-up", "Current answer"]);
  expect(f.s.phase).toBe("answered"); expect(f.s.turn).toBeUndefined();
});

test("permission changes drain the turn and leave queued inputs for explicit resumption", async () => {
  const f = controlled();
  f.chats.send(f.s.id, "First");
  f.chats.submit(f.s.id, "Queued", { id: "queued-input-001", mode: "text" });
  const change = f.chats.setPermissions({ version: 2, folders: [] });
  // Permission normalization uses a dynamic import; wait for cancellation, not time.
  await new Promise<void>(resolve => {
    const signal = f.calls[0]!.args.signal;
    if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  f.calls[0]!.complete("Late answer"); await change;
  expect(f.s.phase).toBe("interrupted"); expect(f.s.pendingInputs).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
});

test("production archive becomes dormant before the old turn drains", async () => {
  const f = controlled();
  f.chats.send(f.s.id, "First");
  const closing = f.chats.stopTree(f.s.id);
  expect(f.s.deactivatedAt).toBe(at); expect(f.s.lifecycle).toBe("dormant");
  f.calls[0]!.args.event?.("assistantMessage", { id: "late", text: "Do more work" });
  f.calls[0]!.complete("Late completion"); await closing;
  expect(f.s.messages.map(m => m.text)).toEqual(["First"]);
  expect(f.s.lifecycle).toBe("dormant"); expect(f.s.turn).toBeUndefined();
});
