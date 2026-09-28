/**
 * The launch_agent recovery contract. A failed launch names its durable
 * request, says where it stopped and whether re-issuing it is safe, keeps the
 * agent it may have created, and never creates a second worker.
 */
import { afterEach, expect, test } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
import { AgentOrchestrator } from "../lib/agentOrchestrator";
import { AGENT_ORCHESTRATION_TOOLS } from "../lib/agentOrchestrationTools";
import { nativeVault } from "./support/vault";
import { fakePi } from "./support/pi";
import { PilotChats } from "./support/pilotSession";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const LAUNCH = { title: "Fabricated task", task: "Do the fabricated task", context: "Fabricated context" };

function world(options: { losePastCreation?: boolean } = {}) {
  const root = realpathSync(nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n" } }));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agents = new AgentOrchestrator(root, { loadPi: fakePi(() => ({ result: "Done" })) });
  cleanups.push(() => agents.close());
  let created: string | undefined;
  // The worker is created and persisted, then the reply never reaches the caller.
  const external = !options.losePastCreation ? agents : new Proxy(agents, { get: (t, k, r) => k !== "launch" ? Reflect.get(t, k, r)
    : (...args: unknown[]) => { created = (t as any).launch(...args).id; throw new Error("Connection closed before the reply was delivered."); } });
  const chats = new PilotChats(root, { graph: () => [], external });
  cleanups.push(() => chats.close());
  const session = chats.create([]);
  session.messages.push({ id: "fabricated-user-message", role: "user", text: "Start a worker", at: new Date().toISOString() });
  const tool = (args: Record<string, unknown>) => (chats as any).tool(session, "launch_agent", args, new AbortController().signal);
  return { root, agents, chats, session, tool, createdId: () => created };
}

test("a durable receipt is written before any side effect", async () => {
  const w = world();
  await w.tool(LAUNCH);
  const receipt = w.chats.actionReceipts(w.session.id).receipts[0] as any;
  expect(receipt).toMatchObject({ operation: "launch_agent", status: "completed" });
  expect(w.agents.list()).toHaveLength(1);
});

test("an identical retry never creates a second worker", async () => {
  const w = world();
  const first = await w.tool(LAUNCH) as { id: string };
  const second = await w.tool(LAUNCH) as { id: string };
  expect(second.id).toBe(first.id);
  expect(w.agents.list()).toHaveLength(1);
});

test("a failed launch names the request receipt so Pilot can reconcile it", async () => {
  const w = world({ losePastCreation: true });
  const result = await w.tool(LAUNCH) as Record<string, unknown>;
  const receipt = w.chats.actionReceipts(w.session.id).receipts[0] as any;
  expect(result.request).toBe(receipt.id);
});

test("a failed launch states the stage, the cause and whether a retry is safe", async () => {
  const w = world({ losePastCreation: true });
  const result = await w.tool(LAUNCH) as Record<string, unknown>;
  expect(result).toMatchObject({ status: "unknown", stage: "execute", retry: "blocked" });
  expect(String(result.cause)).toContain("Connection closed");
});

test("a deterministic refusal is reported as failed with its cause, not as an unknown outcome", async () => {
  const w = world();
  const result = await w.tool({ ...LAUNCH, mode: "admin" }) as Record<string, unknown>;
  expect(String(result.error)).toContain("read or work");
  expect(result).toMatchObject({ status: "failed", retry: "safe" });
  expect(w.chats.actionReceipts(w.session.id).receipts[0]).toMatchObject({ status: "failed" });
});

test("an agent created before the response was lost is recoverable by request identity", async () => {
  const w = world({ losePastCreation: true });
  await w.tool(LAUNCH);
  const receipt = w.chats.actionReceipts(w.session.id).receipts[0] as any;
  const agent = w.createdId()!;
  expect(JSON.stringify(receipt)).toContain(agent);
  expect(receipt.observations).toEqual([{ kind: "agent", target: agent, confirmed: false }]);
});

test("Pilot can look up its own outstanding requests without the user opening the worker panel", () => {
  expect(AGENT_ORCHESTRATION_TOOLS.map(t => t.name)).toContain("read_action");
});

test("after restart, an uncertain launch reconciles to its worker automatically", async () => {
  const w = world({ losePastCreation: true });
  await w.tool(LAUNCH);
  w.chats.close(); w.agents.close();
  const agents = new AgentOrchestrator(w.root, { loadPi: fakePi(() => ({ result: "Done" })) });
  cleanups.push(() => agents.close());
  const chats = new PilotChats(w.root, { graph: () => [], external: agents });
  cleanups.push(() => chats.close());
  const receipt = chats.actionReceipts(w.session.id).receipts[0] as any;
  expect(receipt.status).toBe("completed");
  expect(receipt.observations?.[0]?.target).toBe(w.createdId());
  expect(agents.list()).toHaveLength(1);
});
