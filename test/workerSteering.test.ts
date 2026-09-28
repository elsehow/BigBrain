/** Steering a running worker: the actual Pi agent loop with scripted inference,
 * the Pilot tool path through ApplicationActions, and restart from disk. */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentOrchestrator, type AgentSessionReport } from "../lib/agentOrchestrator";
import { fakePi, type ModelAnswer } from "./support/pi";
import { mdVault, nativeVault } from "./support/vault";
import { PilotChats } from "./support/pilotSession";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
async function until(fn: () => boolean) { for (let i = 0; i < 400; i++) { if (fn()) return; await Bun.sleep(10); } throw Error("Timed out"); }
const call = (name: string, args: Record<string, unknown>): ModelAnswer => ({ content: [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }] });
const pilotCall = (name: string, args: unknown) => ({ type: "function_call", call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
type Step = ModelAnswer | ((prompt: string) => ModelAnswer);
type Hooks = { changed?: () => void; settling?: () => void };
const words = (m: { content: unknown }) => typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map(c => c.text ?? "").join("");
function fixture(steps: Step[], hook: Hooks = {}) {
  const root = realpathSync(nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n" } })); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const prompts: string[] = [];
  const fake = fakePi(prompt => { prompts.push(prompt); const step = steps.shift() ?? { result: "Done" }; return typeof step === "function" ? step(prompt) : step; });
  // contexts: every user message each model request saw. settling: Pi finished a run but the turn has not returned.
  const contexts: string[][] = [];
  const loadPi = async () => {
    const sdk: any = await fake(), create = sdk.ModelRuntime.create;
    return { ...sdk, ModelRuntime: { create: async (...a: unknown[]) => {
      const runtime = await create(...a), stream = runtime.streamSimple;
      runtime.streamSimple = (m: unknown, context: { messages: { role: string; content: unknown }[] }, o: unknown) => { contexts.push(context.messages.filter(v => v.role === "user").map(words)); return stream(m, context, o); };
      return runtime;
    } }, createAgentSession: async (o: unknown) => {
      const result = await sdk.createAgentSession(o), prompt = result.session.prompt.bind(result.session);
      result.session.prompt = async (...a: unknown[]) => { await prompt(...a); hook.settling?.(); };
      return result;
    } };
  };
  const agents = new AgentOrchestrator(root, { loadPi, changes: { changed: () => hook.changed?.() } as never }); cleanups.push(() => agents.close());
  // Scripted Pilot inference: each request answers with the next list of Responses output items.
  const pilotOutputs: unknown[][] = [], pilotRequests: any[] = [];
  const chats = new PilotChats(root, { external: agents, graph: () => [], fetch: (async (_url: unknown, init: RequestInit) => {
    pilotRequests.push(JSON.parse(String(init.body)));
    const event = { type: "response.completed", response: { status: "completed", output: pilotOutputs.shift() ?? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Noted." }] }] } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch }); cleanups.push(() => chats.close());
  // Registered after PilotChats so reports are observed without automatic Pilot report turns.
  const reports: AgentSessionReport[] = []; agents.setReporter(r => reports.push(r));
  const pilot = chats.create([]);
  const launch = (owner = pilot.id) => agents.launch(owner, "message", { title: "Fixture task", task: "Inspect the synthetic ledger", context: "Synthetic evidence" }, []);
  // The production Pilot tool path: ownership, authorization, validation and receipts.
  const tool = (name: string, args: Record<string, unknown>, owner = pilot.id) => (chats as any).tool(chats.get(owner), name, args, new AbortController().signal);
  return { root, agents, reports, chats, pilot, prompts, contexts, launch, tool, pilotOutputs, pilotRequests };
}
const running = (job: { worker: { operations: { status: string }[] } }) => job.worker.operations.at(-1)?.status === "started";
const steering = (job: { worker: { steering?: { text: string; status: string }[] } }) => (job.worker.steering ?? []).map(s => `${s.text}:${s.status}`);

test("a Pilot model turn steers a worker mid-tool; delivery is FIFO at the next model request and retries do not enqueue twice", async () => {
  const f = fixture([call("bash", { command: "sleep 1" }), { result: "Applied the ledger note" }, { result: "Applied the date note" }]);
  const job = f.launch(), choice = structuredClone(job.choice), grant = structuredClone(job.worker.grant);
  await until(() => running(job));
  const note = "Also compare the March ledger", second = "Report dates in ISO form";
  // The retry repeats the same call within one user turn: the same delivery identity.
  f.pilotOutputs.push([pilotCall("message_agent", { agent: job.id, text: note }), pilotCall("message_agent", { agent: job.id, text: note })], [pilotCall("message_agent", { agent: job.id, text: second })]);
  f.chats.send(f.pilot.id, "Tell the worker two more things"); await f.chats.settled(f.pilot.id);
  expect(f.pilot.phase).toBe("answered");
  const replies = f.pilotRequests.at(-1).input.filter((i: any) => i.type === "function_call_output").map((i: any) => JSON.parse(i.output));
  expect(replies[0]).toMatchObject({ accepted: true, agent: job.id, delivery: "queued", status: "queued", ahead: 0 });
  expect(replies[1].instruction).toBe(replies[0].instruction); // Same delivery identity: the receipt answers, nothing is re-enqueued.
  expect(replies.at(-1)).toMatchObject({ accepted: true, delivery: "queued", ahead: 1 });
  expect(steering(job)).toEqual([`${note}:queued`, `${second}:queued`]);
  expect(f.prompts).toHaveLength(1); // Accepted is not delivered: no model request has seen either instruction yet.
  await until(() => job.status === "idle");
  expect(f.prompts[1]).toContain(note); expect(f.prompts[1]).not.toContain(second);
  expect(f.prompts[2]).toContain(second);
  expect(f.contexts.at(-1)!.filter(t => t.includes(note))).toHaveLength(1); expect(f.contexts.at(-1)!.filter(t => t.includes(second))).toHaveLength(1);
  expect(steering(job)).toEqual([`${note}:delivered`, `${second}:delivered`]);
  expect(job.messages.filter(m => m.role === "user").map(m => m.text).slice(1)).toEqual([note, second]);
  expect(job.choice).toEqual(choice); expect(job.worker.grant).toEqual(grant);
  expect(f.reports.filter(r => r.kind === "completed").map(r => r.text)).toEqual(["Applied the date note"]);
  const read = await f.tool("read_agent", { agent: job.id });
  expect(read.worker.steering.map((s: any) => s.status)).toEqual(["delivered", "delivered"]);
}, 15_000);

test("steering that arrives as the final answer completes is delivered in the same run, never dropped", async () => {
  let f!: ReturnType<typeof fixture>, job!: ReturnType<ReturnType<typeof fixture>["launch"]>;
  f = fixture([() => { f.agents.instruct(job.id, "Late ledger note", f.pilot.id); return { result: "First answer" }; }, { result: "Followed the late note" }]);
  job = f.launch(); await until(() => job.status === "idle");
  expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain("Late ledger note");
  expect(steering(job)).toEqual(["Late ledger note:delivered"]);
  expect(f.reports.filter(r => r.kind === "completed").map(r => r.text)).toEqual(["Followed the late note"]);
});

test("steering accepted after Pi's last poll starts a follow-up turn before the worker reports completion", async () => {
  const hook: Hooks = {};
  const f = fixture([{ result: "First answer" }, { result: "Followed the late note" }], hook);
  const job = f.launch();
  let reply: unknown;
  let sent = false;
  hook.changed = () => { if (!sent && job.messages.at(-1)?.text === "First answer") { sent = true; reply = f.agents.instruct(job.id, "Late ledger note", f.pilot.id).reply; } };
  await until(() => job.status === "idle");
  expect(reply).toMatchObject({ delivery: "queued" });
  expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain("Late ledger note");
  expect(steering(job)).toEqual(["Late ledger note:delivered"]);
  expect(f.reports.filter(r => r.kind === "completed").map(r => r.text)).toEqual(["Followed the late note"]);
});

test("steering Pi accepted while settling is withdrawn from Pi and delivered exactly once by the follow-up turn", async () => {
  const hook: Hooks = {};
  const f = fixture([{ result: "First answer" }, { result: "Followed the settling note" }], hook);
  const job = f.launch();
  let reply: any;
  hook.settling = () => { if (!reply) reply = f.agents.instruct(job.id, "Settling ledger note", f.pilot.id).reply; };
  await until(() => job.status === "idle");
  expect(reply).toMatchObject({ delivery: "queued" });
  expect(f.prompts).toHaveLength(2); expect(steering(job)).toEqual(["Settling ledger note:delivered"]);
  expect(f.contexts.at(-1)!.filter(t => t.includes("Settling ledger note"))).toHaveLength(1);
  expect(f.reports.filter(r => r.kind === "completed").map(r => r.text)).toEqual(["Followed the settling note"]);
});

test("stop wins: queued steering is withdrawn, never restarts the worker, and a later follow-up carries only new text", async () => {
  const f = fixture([call("bash", { command: "sleep 1" }), { result: "Fresh turn" }, call("bash", { command: "sleep 1" })]);
  const job = f.launch(); await until(() => running(job));
  expect(await f.tool("message_agent", { agent: job.id, text: "Queued ledger note" })).toMatchObject({ delivery: "queued" });
  await f.agents.interrupt(job.id); await f.agents.settled(job.id); await Bun.sleep(50);
  expect(job.status).toBe("interrupted"); expect(f.prompts).toHaveLength(1);
  expect(job.worker.steering?.[0]).toMatchObject({ status: "withdrawn", reason: expect.stringContaining("stopped") });
  expect((await f.tool("read_agent", { agent: job.id })).worker.steering[0].status).toBe("withdrawn");
  expect(await f.tool("message_agent", { agent: job.id, text: "Start over from the summary" })).toMatchObject({ delivery: "started" });
  await until(() => job.status === "idle");
  expect(f.prompts.at(-1)).toContain("Start over from the summary"); expect(f.prompts.at(-1)).not.toContain(job.worker.steering![0]!.id);
  expect(job.worker.steering?.[0]?.status).toBe("withdrawn");
  const other = f.launch(); await until(() => running(other));
  f.agents.instruct(other.id, "Archived note", f.pilot.id); await f.chats.stopTree(f.pilot.id);
  expect(other.worker.steering?.[0]?.status).toBe("withdrawn"); expect(other.worker.archivedAt).toBeTruthy();
  expect(await f.tool("message_agent", { agent: other.id, text: "Continue" })).toMatchObject({ error: expect.any(String) });
}, 15_000);

test("steering never answers a pending ask_pilot; reply_agent still does, and the instruction follows it", async () => {
  const f = fixture([call("ask_pilot", { question: "Which ledger?" }), { result: "Used March" }]);
  const job = f.launch(); await until(() => job.worker.request?.kind === "context");
  const request = job.worker.request!, reports = f.reports.length;
  const reply = await f.tool("message_agent", { agent: job.id, text: "Prefer the March ledger" });
  expect(reply).toMatchObject({ accepted: true, delivery: "queued", note: expect.stringContaining("does not answer it") });
  await Bun.sleep(50);
  expect(job.worker.request).toEqual(request); expect(job.status).toBe("needs-input"); expect(f.prompts).toHaveLength(1);
  expect(f.reports.slice(reports).some(r => r.kind === "resolved")).toBe(false);
  expect(steering(job)).toEqual(["Prefer the March ledger:queued"]);
  expect(await f.tool("reply_agent", { agent: job.id, request: request.id, text: "The March ledger", evidence: [] })).toEqual({ ok: true });
  await until(() => job.status === "idle");
  expect(f.prompts[1]).toContain("Prefer the March ledger"); expect(steering(job)).toEqual(["Prefer the March ledger:delivered"]);
  expect(job.messages.map(m => m.text)).toContain("Pilot answered: The March ledger");
});

test("only the owning Pilot may steer, and revoked project access withdraws and rejects steering", async () => {
  const f = fixture([call("bash", { command: "sleep 1" }), { result: "Done" }]);
  const other = f.chats.create([]), project = realpathSync(mdVault({ files: { "ledger.txt": "Synthetic" } })); cleanups.push(() => rmSync(project, { recursive: true, force: true }));
  const saved = f.agents.projects.save({ label: "Ledger project", path: project, mode: "work", references: [], domains: [], accounts: [] });
  const job = f.agents.launch(f.pilot.id, "message", { title: "Project task", task: "Inspect", context: "Synthetic", project: saved.id }, []);
  await until(() => running(job));
  expect(await f.tool("message_agent", { agent: job.id, text: "Foreign note" }, other.id)).toMatchObject({ error: expect.stringContaining("different Pilot") });
  expect(() => f.agents.validateMessage(job.id, "Foreign note", other.id)).toThrow("different Pilot");
  expect(await f.tool("message_agent", { agent: job.id, text: "Owned note" })).toMatchObject({ delivery: "queued" });
  f.agents.projects.remove(saved.id);
  expect(job.status).toBe("interrupted");
  expect(job.worker.steering?.map(s => s.text)).toEqual(["Owned note"]);
  expect(job.worker.steering?.[0]).toMatchObject({ status: "withdrawn", reason: expect.stringContaining("access changed") });
  await f.agents.settled(job.id);
  expect(await f.tool("message_agent", { agent: job.id, text: "Retry note" })).toMatchObject({ error: expect.stringContaining("revoked") });
  expect(f.prompts).toHaveLength(1);
}, 15_000);

test("restart withdraws undelivered steering honestly and does not resume the worker", async () => {
  const f = fixture([call("bash", { command: "sleep 1" })]);
  const job = f.launch(); await until(() => running(job));
  f.agents.instruct(job.id, "Queued before the crash", f.pilot.id);
  const file = join(f.root, ".spool", "workers", `${job.id}.json`), crashed = readFileSync(file, "utf8");
  expect(JSON.parse(crashed).worker.steering[0].status).toBe("queued");
  f.agents.close(); await f.agents.settled(job.id);
  writeFileSync(file, crashed); // As if the process died with the instruction still queued.
  const prompts: string[] = []; let loaded = 0;
  const pi = fakePi(prompt => { prompts.push(prompt); return { result: "Resumed explicitly" }; });
  const restored = new AgentOrchestrator(f.root, { loadPi: async () => { loaded++; return pi(); } }); cleanups.push(() => restored.close());
  const record = restored.get(job.id);
  expect(record.status).toBe("interrupted");
  expect(record.worker.steering?.[0]).toMatchObject({ status: "withdrawn", reason: expect.stringContaining("restarted") });
  await Bun.sleep(50); expect(loaded).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).worker.steering[0].status).toBe("withdrawn");
  const { reply } = restored.instruct(job.id, "Continue with the summary", f.pilot.id);
  expect(reply).toMatchObject({ delivery: "started" });
  await until(() => record.status === "idle");
  expect(prompts).toHaveLength(1); expect(prompts[0]).toContain("Continue with the summary"); expect(prompts[0]).not.toContain("Queued before the crash");
  expect(record.worker.steering?.map(s => s.status)).toEqual(["withdrawn", "delivered"]);
}, 15_000);

test("records written before steering existed still load", () => {
  const f = fixture([]), job = f.launch(), file = join(f.root, ".spool", "workers", `${job.id}.json`);
  f.agents.close();
  const saved = JSON.parse(readFileSync(file, "utf8")); delete saved.worker.steering; saved.status = "idle"; writeFileSync(file, JSON.stringify(saved));
  const restored = new AgentOrchestrator(f.root); cleanups.push(() => restored.close());
  expect(restored.loadIssues).toEqual([]); expect(restored.get(job.id).worker.steering).toBeUndefined();
});
