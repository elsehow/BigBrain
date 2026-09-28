/**
 * Competing-cause matrix at the launch_agent boundary. Each row injects one
 * fabricated failure and records what Pilot is told, what the durable receipt
 * says, and whether a worker exists. A refusal before any effect keeps its
 * cause and is safe to retry; only a possible effect is reported as unknown.
 */
import { afterEach, expect, test } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
import { AgentOrchestrator } from "../lib/agentOrchestrator";
import { PilotError } from "../lib/pilot";
import { mdVault, nativeVault } from "./support/vault";
import { fakePi } from "./support/pi";
import { PilotChats } from "./support/pilotSession";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const AMBIGUOUS = "The operation did not return a confirmed outcome. Inspect existing results before requesting it again.";
const LAUNCH = { title: "Fabricated task", task: "Do the fabricated task", context: "Fabricated context" };

function world(options: { tool?: (name: string) => Promise<unknown> } = {}) {
  const root = realpathSync(nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n" } }));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agents = new AgentOrchestrator(root, { loadPi: fakePi(() => ({ result: "Done" })) });
  cleanups.push(() => agents.close());
  const chats = new PilotChats(root, { graph: () => [], external: agents, tool: options.tool });
  cleanups.push(() => chats.close());
  const session = chats.create([]);
  // A user message is the delivery identity for tool actions in the production path.
  session.messages.push({ id: "fabricated-user-message", role: "user", text: "Start a worker", at: new Date().toISOString() });
  // Drive the same private entry point PilotChats.run() uses for every tool call.
  const tool = (args: Record<string, unknown>, name = "launch_agent") => (chats as any).tool(session, name, args, new AbortController().signal);
  return { root, agents, chats, session, tool };
}
const observe = async (w: ReturnType<typeof world>, args: Record<string, unknown>) => {
  const result = await w.tool(args) as Record<string, unknown>;
  const receipt = w.chats.actionReceipts(w.session.id).receipts[0] as any;
  return { delivered: result, receipt: receipt ? { status: receipt.status, stage: receipt.stage, cause: receipt.cause } : null, workers: w.agents.list().length };
};
const occupy = (w: ReturnType<typeof world>) => {
  for (let i = 0; i < 4; i++) {
    const project = realpathSync(mdVault({ files: { "hello.txt": "Original" } })); cleanups.push(() => rmSync(project, { recursive: true, force: true }));
    w.agents.launch("pilot-other", "message", { ...LAUNCH, title: `Occupied ${i}`, cwd: project, mode: "work" }, []);
  }
};

test("matrix: every refusal before an effect keeps its cause, fails, and is safe to retry", async () => {
  const unavailableModel = world();
  (unavailableModel.chats as any).models = async () => [{ id: "pi/anthropic", label: "Claude", ready: true, models: [{ id: "claude-sonnet-5", label: "Sonnet" }] }];
  const saturated = world(); occupy(saturated);
  const shuttingDown = world(); shuttingDown.agents.close();
  const rows: [string, ReturnType<typeof world>, Record<string, unknown>, string][] = [
    ["context over 64,000 characters", world(), { ...LAUNCH, context: "x".repeat(64_001) }, "Provide context under 64000 characters."],
    ["title over 100 characters", world(), { ...LAUNCH, title: "t".repeat(101) }, "Provide a title under 100 characters."],
    ["four sessions already active", saturated, LAUNCH, "Four agent sessions are active. Wait for or stop one first."],
    ["mode neither read nor work", world(), { ...LAUNCH, mode: "admin" }, "Choose read or work mode."],
    ["explicit model not connected", unavailableModel, { ...LAUNCH, model: { adapter: "pi", provider: "anthropic", model: "not-connected" } }, "The requested model is not connected or available. Choose a connected model explicitly."],
    ["environment proposal without a folder", world(), { ...LAUNCH, environment: { mode: "work", references: [], domains: [], accounts: [] } }, "Choose a project folder before proposing an environment."],
    ["orchestrator shutting down", shuttingDown, LAUNCH, "Agent sessions are shutting down."],
  ];
  for (const [cause, w, args, error] of rows) {
    const row = await observe(w, args);
    expect({ cause, ...row }).toMatchObject({ cause, delivered: { error, operation: "launch_agent", status: "failed", stage: "validate", retry: "safe" },
      receipt: { status: "failed", stage: "validate", cause: error }, workers: cause === "four sessions already active" ? 4 : 0 });
  }
  // The authorize stage runs before any durable receipt.
  expect(await observe(world(), { ...LAUNCH, project: "project-does-not-exist" })).toEqual({
    delivered: { error: "Choose a current authorized project.", operation: "launch_agent", status: "failed", stage: "request", retry: "safe" }, receipt: null, workers: 0 });
});

test("a refusal that races validation inside launch() is still a safe failure", async () => {
  const w = world();
  // Fabricated race: capacity fills between the validate stage and dispatch.
  const validate = w.agents.validateLaunch.bind(w.agents);
  w.agents.validateLaunch = (...args) => { const plan = validate(...args); w.agents.validateLaunch = validate; occupy(w); return plan; };
  const row = await observe(w, LAUNCH);
  expect(row).toMatchObject({ delivered: { error: "Four agent sessions are active. Wait for or stop one first.", status: "failed", stage: "execute", retry: "safe" },
    receipt: { status: "failed", stage: "execute" }, workers: 4 });
});

test("cancellation: an abort before dispatch is a safe failure; an abort after the worker exists names it", async () => {
  const before = world();
  const aborted = new AbortController(); aborted.abort();
  const early = await (before.chats as any).tool(before.session, "launch_agent", LAUNCH, aborted.signal);
  expect(early).toMatchObject({ status: "failed", retry: "safe" });
  expect(early.error).not.toBe(AMBIGUOUS);
  expect(before.agents.list()).toHaveLength(0);

  const during = world();
  const controller = new AbortController();
  let created: string | undefined;
  const lossy = new Proxy(during.agents, { get: (t, k, r) => k !== "launch" ? Reflect.get(t, k, r)
    : (...args: unknown[]) => { created = (t as any).launch(...args).id; controller.abort(); return (t as any).get(created); } });
  (during.chats as any).options.external = lossy;
  const late = await (during.chats as any).tool(during.session, "launch_agent", LAUNCH, controller.signal);
  expect(created).toMatch(/^work-[a-f0-9]{32}$/);
  expect(late).toMatchObject({ error: AMBIGUOUS, status: "unknown", stage: "execute", retry: "blocked", agent: created });
});

test("shape: an application action replies with a handle; a direct tool error still carries context", async () => {
  const w = world();
  const direct = await (w.chats as any).executeTool(w.session, "launch_agent", { ...LAUNCH, mode: "admin" }, new AbortController().signal);
  expect(Object.keys(direct as object).sort()).toEqual(["context", "error", "revision"]);
  const viaAction = await w.tool({ ...LAUNCH, mode: "admin" });
  expect(Object.keys(viaAction as object).sort()).toEqual(["error", "operation", "request", "retry", "stage", "status"]);
});

test("the other Pilot-owned actions share the handle and keep their cause", async () => {
  const w = world({ tool: async () => { throw new PilotError("Fabricated intake refusal."); } });
  // Ownership lookup happens in authorize, before any receipt.
  expect(await w.tool({ agent: "work-00000000000000000000000000000000", text: "Follow-up" }, "message_agent"))
    .toEqual({ error: "Agent session not found.", operation: "message_agent", status: "failed", stage: "request", retry: "safe" });
  // A shared write tool cannot prove it did nothing, so its verdict stays unknown with the cause kept.
  const drop = await w.tool({ content: "Fabricated contribution" }, "drop") as Record<string, unknown>;
  expect(drop).toMatchObject({ error: AMBIGUOUS, operation: "drop", status: "unknown", stage: "execute", retry: "blocked", cause: "Fabricated intake refusal." });
  expect(w.chats.actionReceipts(w.session.id).receipts).toMatchObject([{ id: drop.request, operation: "drop", status: "uncertain", cause: "Fabricated intake refusal.", observations: [] }]);
});

test("forensics: the real cause reaches Pilot and its durable receipt, not only retained tool evidence", async () => {
  const w = world(); occupy(w);
  const delivered = await w.tool(LAUNCH);
  expect(JSON.stringify(delivered)).toContain("Four agent sessions are active");
  expect(w.chats.actionReceipts(w.session.id).receipts).toMatchObject([{ status: "failed", cause: "Four agent sessions are active. Wait for or stop one first." }]);
});
