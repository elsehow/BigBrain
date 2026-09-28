/** Synthetic characterization through the production desktop initializer.
 * Run alone: spies replace model/worker-executor boundaries, never scheduling,
 * persistence, transitions, authority checks, notification tools or routes.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopRouteManifest } from "../web/desktopRouteManifest";
import { PilotChats } from "../lib/pilotChat";
import { AgentOrchestrator } from "../lib/agentOrchestrator";
import { PiSession } from "../lib/run/piSession";
import { newPilotChatSession, type PilotChatSession } from "../lib/pilotChatTypes";
import { DEFAULT_PILOT_BACKEND } from "../lib/pilotBackendTypes";
import type { ModelSessionTurn } from "../lib/run/session";
import { ApplicationChanges } from "../lib/applicationChanges";
import { nativeVault } from "./support/vault";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(r => setImmediate(r)); };
async function until(fn: () => boolean) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw Error("Fixture did not settle"); }
function seed(root: string, over: Partial<PilotChatSession> = {}) {
  const s = { ...newPilotChatSession([]), backend: DEFAULT_PILOT_BACKEND, phase: "answered" as const, ...over };
  mkdirSync(join(root, ".spool/pilot-chats"), { recursive: true });
  writeFileSync(join(root, ".spool/pilot-chats", `${s.id}.json`), JSON.stringify(s));
  return s;
}
function rootFixture() {
  const root = nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n", "vault.yaml": "integrations: {}\n" } });
  cleanups.push(() => { if (!process.env.KEEP_REPORT_FIXTURES) rmSync(root, { recursive: true, force: true }); });
  return root;
}
function boot(root: string, model: (args: ModelSessionTurn, s: PilotChatSession) => Promise<string> = async (args, s) => { for (const reportKey of s.turn?.reports ?? []) await args.tool("notify_user", { key: "fixture", reportKey, kind: "update", text: "Fixture handled." }); return "Noted."; }) {
  let chats!: PilotChats, agents!: AgentOrchestrator;
  const prompts: string[] = [];
  const maintenance = PilotChats.prototype.startMaintenance;
  const reporter = AgentOrchestrator.prototype.setReporter;
  const spies = [
    spyOn(PilotChats.prototype, "startMaintenance").mockImplementation(function(this: PilotChats) {
      // Capture the actual instance made by the production initializer.
      // oxlint-disable-next-line typescript/no-this-alias
      chats = this;
      // Categories are an unrelated model consumer, not the report scheduler.
      (this as any).options.categories = false;
      maintenance.call(this);
    }),
    spyOn(AgentOrchestrator.prototype, "setReporter").mockImplementation(function(this: AgentOrchestrator, callback) {
      // Capture without replacing constructor or reporter registration.
      // oxlint-disable-next-line typescript/no-this-alias
      agents = this; reporter.call(this, callback);
    }),
    spyOn(PilotChats.prototype as any, "runtime").mockImplementation((_s: unknown) => {
      const s = _s as PilotChatSession;
      return { transport: "api", broken: false, prepare: async () => true, close() {}, turn: async (args: ModelSessionTurn) => {
        prompts.push(args.input(true)); args.connected(); args.dispatched?.(); return model(args, s);
      } };
    }),
    spyOn(AgentOrchestrator.prototype as any, "executor").mockImplementation(async (_job: unknown, runtime: any) => {
      runtime.scope = { project: root, scratch: root, mode: "read", references: [], domains: [] };
      runtime.tools = [];
    }),
  ];
  const changes = new ApplicationChanges(), invalidations: unknown[] = [];
  const unsub = changes.subscribe(e => invalidations.push(e));
  const exits = new Set(process.listeners("exit"));
  const routes = desktopRouteManifest(root, { includeSupport: false, changes });
  const addedExits = process.listeners("exit").filter(fn => !exits.has(fn));
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    chats.close(); unsub(); for (const fn of addedExits) process.removeListener("exit", fn);
    for (const spy of spies.reverse()) spy.mockRestore();
  };
  cleanups.push(stop);
  return { chats, agents, prompts, routes, changes, invalidations, stop };
}
function workerScript(script: (args: ModelSessionTurn) => Promise<string>) {
  const spy = spyOn(PiSession.prototype, "turn").mockImplementation(script);
  cleanups.push(() => spy.mockRestore());
}
const launch = (f: ReturnType<typeof boot>, pilot: string) => f.agents.launch(pilot, "synthetic-user-message", { title: "Fixture task", task: "Inspect synthetic evidence", context: "Use the blue fixture." }, []);
const disk = (root: string, id: string) => JSON.parse(readFileSync(join(root, ".spool/pilot-chats", `${id}.json`), "utf8"));
function httpNotifications(f: ReturnType<typeof boot>) {
  let result: any;
  f.routes.find(r => r.path === "/api/pilot/chat/notifications")!.handler({ res: { writeHead() {}, end(text: string) { result = JSON.parse(text); } } } as any);
  return result.notifications;
}
const report = () => ({ key: "fixture:completion", work: "fixture", kind: "completed" as const, title: "Fixture", text: "Checked.", at: new Date().toISOString() });

test("production boot: concurrent context requests wake without user input; replies and notification reach durable HTTP state", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async args => { await args.tool("ask_pilot", { question: "Which fixture color?" }); return "Fixture checked."; });
  const f = boot(root, async args => {
    for (const job of f.agents.list()) {
      const request = f.agents.get(job.id).worker.request;
      if (request?.kind === "context") await args.tool("reply_agent", { agent: job.id, request: request.id, text: "Blue, per established task context.", evidence: [] });
    }
    for (const reportKey of f.chats.get(s.id).turn?.reports ?? []) {
      if (f.chats.get(s.id).pendingAgentSessionReports?.includes(reportKey)) await args.tool("notify_user", { key: "fixture-summary", reportKey, kind: "update", text: "Synthetic checks completed." });
    }
    await expect(args.tool("launch_agent", {})).rejects.toThrow("cannot authorize");
    await expect(args.tool("message_agent", {})).rejects.toThrow("cannot authorize");
    await expect(args.tool("write_scratch", {})).rejects.toThrow("can only read");
    return "Handled.";
  });
  const jobs = [launch(f, s.id), launch(f, s.id)];
  await until(() => jobs.every(j => j.status === "idle") && !f.chats.get(s.id).turn); await tick();
  expect(f.prompts.length).toBeGreaterThan(0);
  expect(jobs.every(j => !j.worker.request)).toBe(true);
  expect(f.chats.get(s.id).pendingAgentSessionReports).toEqual([]);
  expect(disk(root, s.id).notifications.length).toBeGreaterThan(0);
  expect(httpNotifications(f).length).toBeGreaterThan(0);
  f.changes.flush(); expect(f.invalidations.length).toBeGreaterThan(0);
});

test("report during active turn is persisted, then drained after that turn (no second user message)", async () => {
  const root = rootFixture(), s = seed(root);
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root, async (args, current) => { if (!current.turn?.reports) await gate; for (const reportKey of current.turn?.reports ?? []) await args.tool("notify_user", { key: "fixture", reportKey, kind: "update", text: "Done." }); return "Done."; });
  f.chats.send(s.id, "Inspect fixture"); launch(f, s.id); await tick();
  expect(f.prompts).toHaveLength(1);
  expect(disk(root, s.id).pendingAgentSessionReports).toHaveLength(1);
  release(); await until(() => f.prompts.length === 2 && !f.chats.get(s.id).turn);
  expect(f.chats.get(s.id).pendingAgentSessionReports).toEqual([]);
});

for (const phase of ["interrupted", "failed"] as const) test(`${phase} Pilot escalates without resuming`, async () => {
  const root = rootFixture(), s = seed(root, { phase });
  workerScript(async () => "Synthetic completion.");
  const f = boot(root); launch(f, s.id); await tick(); await f.chats.sweep(); await tick();
  expect(f.prompts).toHaveLength(0);
  expect(disk(root, s.id).pendingAgentSessionReports).toEqual([]);
  expect(httpNotifications(f)).toHaveLength(1);
});
for (const wasRunning of [false, true]) test(`restart handles or escalates durable report (in flight=${wasRunning})`, async () => {
  const root = rootFixture(), r = report();
  const s = seed(root, { pendingAgentSessionReports: [r.key], workEvents: [r], ...(wasRunning ? { phase: "working", turn: { id: "fixture-turn", status: "running", reports: [r.key] } } : {}) });
  const f = boot(root); await tick(); await f.chats.sweep(); await tick();
  expect(f.prompts).toHaveLength(wasRunning ? 0 : 1);
  expect(disk(root, s.id).pendingAgentSessionReports).toEqual([]);
  expect(httpNotifications(f)).toHaveLength(1);
});
test("prose alone stays pending; bounded retries escalate with a stable key", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async args => { await args.tool("ask_pilot", { question: "Which fixture?" }); return "Done."; });
  const f = boot(root, async () => "Noted."), job = launch(f, s.id);
  await tick();
  expect(job.status).toBe("needs-input");
  expect(f.chats.get(s.id).pendingAgentSessionReports).toHaveLength(1);
  await f.chats.sweep(); await tick(); expect(f.prompts).toHaveLength(1);
  let now = Date.now(); (f.chats as any).now = () => now;
  for (let i = 0; i < 3; i++) { now += 100_000; await f.chats.sweep(); await tick(); }
  expect(f.prompts).toHaveLength(3);
  expect(httpNotifications(f)).toHaveLength(1);
  expect(disk(root, s.id).pendingAgentSessionReports).toEqual([]);
  f.stop(); const restarted = boot(root); await tick();
  expect(httpNotifications(restarted)).toHaveLength(1);
  expect(restarted.prompts).toHaveLength(0);
});

function savedWorker(root: string, pilot: string, requestKind?: "context" | "question") {
  const id = `work-${"b".repeat(32)}`, at = new Date().toISOString();
  mkdirSync(join(root, ".spool/workers"), { recursive: true });
  writeFileSync(join(root, ".spool/workers", `${id}.json`), JSON.stringify({ version: 1, id, title: "Fixture", cwd: root, provider: "pi", model: DEFAULT_PILOT_BACKEND.model, choice: DEFAULT_PILOT_BACKEND, status: requestKind ? "needs-input" : "idle", origin: { pilot, message: "fixture" }, context: {}, created: at, updated: at, receipts: [], messages: [{ id: "result", role: "agent", text: "Synthetic completion", at }], worker: { operations: [], ...(requestKind ? { request: { id: "fixture-request", kind: requestKind, text: "Which fixture?" } } : {}) } }));
  return id;
}
test("legacy result without an outbox is not invented as a new delivery", async () => {
  const root = rootFixture(), s = seed(root), id = savedWorker(root, s.id);
  const f = boot(root); await tick();
  expect(f.agents.get(id).status).toBe("idle"); expect(f.prompts).toHaveLength(0);
  expect(f.chats.get(s.id).workEvents ?? []).toEqual([]);
});

test("restart never replays worker operations or answers a now-invalid context request", async () => {
  const root = rootFixture(), s = seed(root), id = savedWorker(root, s.id, "context");
  const f = boot(root); await tick();
  expect(f.agents.get(id).status).toBe("interrupted");
  expect(f.agents.get(id).worker.request).toBeUndefined();
  expect(() => f.agents.answer(s.id, id, "fixture-request", "Blue", [])).toThrow("no longer pending");
  expect(f.prompts).toHaveLength(0);
});

test("notification-before-provider-failure is a per-report receipt across restart", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root, async (args, current) => {
    await args.tool("notify_user", { key: "arbitrary", reportKey: current.turn!.reports![0], kind: "update", text: "Result." });
    throw Error("Synthetic provider interruption");
  });
  launch(f, s.id); await tick();
  expect(disk(root, s.id).pendingAgentSessionReports).toEqual([]);
  expect(httpNotifications(f)).toHaveLength(1);
  f.stop(); const restored = boot(root); await tick();
  expect(restored.prompts).toHaveLength(0); expect(httpNotifications(restored)).toHaveLength(1);
});

test("idle dormancy does not gate fresh reports; explicit deactivation does", async () => {
  const root = rootFixture(), dormant = seed(root, { lifecycle: "dormant" }), closed = seed(root, { deactivatedAt: new Date().toISOString() });
  workerScript(async () => "Synthetic completion.");
  const f = boot(root); launch(f, dormant.id); launch(f, closed.id); await tick();
  expect(f.chats.get(dormant.id).pendingAgentSessionReports).toEqual([]);
  expect(f.prompts).toHaveLength(1);
  expect(f.chats.get(closed.id).pendingAgentSessionReports).toEqual([]);
  expect(f.chats.get(closed.id).notifications).toHaveLength(1);
});

test("capacity saturation defers an answered Pilot and completion of another turn drains it", async () => {
  const root = rootFixture(), busy = Array.from({ length: 4 }, () => seed(root)), waiting = seed(root);
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root, async (args, s) => { if (s.id !== waiting.id) await gate; for (const reportKey of s.turn?.reports ?? []) await args.tool("notify_user", { key: "fixture", reportKey, kind: "update", text: "Done." }); return "Done."; });
  for (const s of busy) f.chats.send(s.id, "Inspect fixture");
  launch(f, waiting.id); await tick();
  expect(f.prompts).toHaveLength(4);
  expect(disk(root, waiting.id).pendingAgentSessionReports).toHaveLength(1);
  release(); await until(() => f.prompts.length === 5 && !f.chats.get(waiting.id).turn);
  expect(f.chats.get(waiting.id).pendingAgentSessionReports).toEqual([]);
});

test("same-key redelivery is deduplicated without another model turn", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root), job = launch(f, s.id); await tick();
  const event = f.chats.get(s.id).workEvents![0]!;
  (f.agents as any).emit(job, "completed", event.key.slice(job.id.length + 1), event.text);
  await tick();
  expect(f.prompts).toHaveLength(1);
  expect(f.chats.get(s.id).workEvents).toHaveLength(1);
  expect(f.chats.get(s.id).pendingAgentSessionReports).toEqual([]);
});

// Prevention contracts exercise production initialization.
test("PREVENTION: startup drains persisted pending report without a user message", async () => {
  const root = rootFixture(), r = report();
  seed(root, { pendingAgentSessionReports: [r.key], workEvents: [r] });
  const f = boot(root); await tick(); await f.chats.sweep(); await tick();
  expect(f.prompts.length).toBeGreaterThan(0);
});

test("PREVENTION: unanswered context request cannot be silently acknowledged by model prose", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async args => { await args.tool("ask_pilot", { question: "Which fixture?" }); return "Done."; });
  const f = boot(root, async () => "Noted."), job = launch(f, s.id); await tick();
  const pending = f.chats.get(s.id).pendingAgentSessionReports?.length ?? 0;
  expect(!job.worker.request || pending > 0 || httpNotifications(f).length > 0).toBe(true);
});

test("PREVENTION: failed Pilot report becomes handled or visibly escalated without user input", async () => {
  const root = rootFixture(), s = seed(root, { phase: "failed" });
  workerScript(async () => "Synthetic completion.");
  const f = boot(root); launch(f, s.id); await tick(); await f.chats.sweep(); await tick();
  expect(f.prompts.length > 0 || httpNotifications(f).length > 0).toBe(true);
});

test("lost delivery is durable: outbox replays at production startup with original key", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root);
  f.agents.setReporter(() => { throw Error("Synthetic lost delivery"); });
  const job = launch(f, s.id); await tick();
  expect(job.status).toBe("idle");
  expect(job.reportOutbox).toHaveLength(1);
  const key = job.reportOutbox![0]!.key;
  const saved = JSON.parse(readFileSync(join(root, ".spool/workers", `${job.id}.json`), "utf8"));
  expect(saved.status).toBe("idle"); expect(saved.reportOutbox[0].key).toBe(key);
  f.stop(); const restored = boot(root); await tick();
  expect(restored.chats.get(s.id).workEvents?.map(r => r.key)).toEqual([key]);
  expect(restored.agents.get(job.id).reportOutbox).toEqual([]);
  expect(httpNotifications(restored)).toHaveLength(1);
});

test("lost sender receipt redelivers without duplicate Pilot history or notifications", async () => {
  const root = rootFixture(), s = seed(root);
  workerScript(async () => "Synthetic completion.");
  const f = boot(root);
  f.agents.setReporter(r => { (f.chats as any).externalReport(r); throw Error("Receipt lost after Pilot commit"); });
  const job = launch(f, s.id); await tick();
  expect(job.reportOutbox).toHaveLength(1);
  expect(httpNotifications(f)).toHaveLength(1);
  f.stop(); const restored = boot(root); await tick();
  expect(restored.chats.get(s.id).workEvents).toHaveLength(1);
  expect(restored.agents.get(job.id).reportOutbox).toEqual([]);
  expect(httpNotifications(restored)).toHaveLength(1);
  expect(restored.prompts).toHaveLength(0);
});

test("partial batch notifications acknowledge only named report; explicit stop survives restart", async () => {
  const root = rootFixture(), a = report(), b = { ...report(), key: "fixture:second" };
  const s = seed(root, { pendingAgentSessionReports: [a.key, b.key], workEvents: [a, b] });
  const f = boot(root, async args => {
    await args.tool("notify_user", { key: "random-one", reportKey: a.key, kind: "update", text: "First result." });
    await args.tool("notify_user", { key: "random-two", reportKey: a.key, kind: "update", text: "First result again." });
    return "Done.";
  });
  await tick(); expect(httpNotifications(f)).toHaveLength(1);
  expect(f.chats.get(s.id).pendingAgentSessionReports).toEqual([b.key]);
  f.chats.stop(s.id); f.stop();
  const restored = boot(root); await tick();
  // Explicit stop escalates the remaining report without a model turn.
  expect(restored.prompts).toHaveLength(0);
  expect(httpNotifications(restored)).toHaveLength(2);
  expect(restored.chats.get(s.id).reportStoppedAt).toBeDefined();
});
