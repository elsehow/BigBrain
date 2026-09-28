/**
 * launch_agent outcomes over the production path, with fabricated failures:
 *
 *   PilotChats.submit -> PilotChats.run -> PilotChats.tool
 *     -> ApplicationActions.execute (receipt persistence)
 *       -> PilotChats.executeTool -> AgentOrchestrator.launch (worker creation)
 *     -> the tool result delivered back over the scripted transport
 *
 * A refusal before any effect and a lost reply after a worker exists must
 * reach Pilot as different, actionable outcomes, and survive a restart.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentOrchestrator } from "../lib/agentOrchestrator";
import { ApplicationActions } from "../lib/applicationActions";
import { fakePi } from "./support/pi";
import { mdVault, nativeVault } from "./support/vault";
import { PilotChats } from "./support/pilotSession";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const AMBIGUOUS = "The operation did not return a confirmed outcome. Inspect existing results before requesting it again.";
const LOST = "Connection closed before the reply was delivered.";

const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (name: string, args: unknown) => ({ type: "function_call", call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
function scripted(outputs: unknown[][], requests: any[] = []) {
  return (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: outputs.shift() ?? [message("Done")] } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
/** Every tool result the model received, in call order. */
const toolResults = (requests: any[]): unknown[] => {
  const seen = new Map<string, unknown>();
  for (const r of requests) for (const v of r.input ?? []) if (v.type === "function_call_output") seen.set(v.call_id, JSON.parse(String(v.output)));
  return [...seen.values()];
};
const toolResult = (requests: any[]): unknown => toolResults(requests).at(-1) ?? null;

function dir() { const p = realpathSync(mdVault({ files: { "hello.txt": "Original" } })); cleanups.push(() => rmSync(p, { recursive: true, force: true })); return p; }
function vault() { const root = realpathSync(nativeVault({ files: { ".env": "BIGBRAIN_PILOT_ENABLED=true\n" } })); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root; }
function orchestrator(root: string) { const agents = new AgentOrchestrator(root, { loadPi: fakePi(() => ({ result: "Done" })) }); cleanups.push(() => agents.close()); return agents; }
/** Creates and persists the worker, then loses the reply. */
function lossy(agents: AgentOrchestrator, seen: { created?: string; attempts: number }) {
  return new Proxy(agents, { get: (target, key, receiver) => key !== "launch" ? Reflect.get(target, key, receiver)
    : (...args: unknown[]) => { seen.attempts++; seen.created = (target as any).launch(...args).id; throw new Error(LOST); } });
}
function world(outputs: unknown[][], options: { external?: any; actions?: ApplicationActions; root?: string } = {}) {
  const root = options.root ?? vault(), agents = orchestrator(root);
  const requests: any[] = [];
  const chats = new PilotChats(root, { graph: () => [], external: options.external?.(agents) ?? agents, actions: options.actions, fetch: scripted(outputs, requests) });
  cleanups.push(() => chats.close());
  return { root, agents, chats, requests };
}
async function turn(chats: PilotChats, id: string, text: string, input: string) { chats.submit(id, text, { id: input, mode: "text" }); await chats.settled(id); }
const LAUNCH = { title: "Fabricated task", task: "Do the fabricated task", context: "Fabricated context" };

test("baseline: an accepted launch returns a stable agent ID over the real transport", async () => {
  const { agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Launched.")]]);
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const result = toolResult(requests) as { id?: string; status?: string };
  expect(result.id).toMatch(/^work-[a-f0-9]{32}$/);
  expect(result.status).toBe("starting");
  expect(agents.list().map(j => j.id)).toContain(result.id);
  const receipt = chats.actionReceipts(session.id).receipts[0] as any;
  expect(receipt).toMatchObject({ operation: "launch_agent", status: "completed" });
  expect(receipt.observations).toEqual([{ kind: "agent", target: result.id, confirmed: true }]);
});

test("cause A: a deterministic pre-effect refusal fails with its own cause and a safe retry", async () => {
  const { agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]]);
  // Fabricated saturation: four sessions already occupy the concurrency ceiling.
  for (let i = 0; i < 4; i++) agents.launch("pilot-other", "message", { ...LAUNCH, title: `Occupied ${i}`, cwd: dir(), mode: "work" }, []);
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const receipt = chats.actionReceipts(session.id).receipts[0] as any;
  expect(toolResult(requests)).toEqual({ error: "Four agent sessions are active. Wait for or stop one first.", request: receipt.id, operation: "launch_agent", status: "failed", stage: "validate", retry: "safe" });
  expect(agents.list()).toHaveLength(4);
  expect(receipt).toMatchObject({ operation: "launch_agent", status: "failed", stage: "validate", cause: "Four agent sessions are active. Wait for or stop one first." });
  expect(receipt.observations).toEqual([]);
});

test("cause B: a lost response after the worker exists is unknown, blocked, and names the worker", async () => {
  const seen = { attempts: 0 } as { created?: string; attempts: number };
  const { agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]], { external: (a: AgentOrchestrator) => lossy(a, seen) });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const receipt = chats.actionReceipts(session.id).receipts[0] as any;
  expect(seen.created).toMatch(/^work-[a-f0-9]{32}$/);
  expect(toolResult(requests)).toEqual({ error: AMBIGUOUS, request: receipt.id, operation: "launch_agent", status: "unknown", stage: "execute", retry: "blocked", cause: LOST, agent: seen.created });
  expect(agents.list().map(j => j.id)).toEqual([seen.created!]);
  expect(receipt).toMatchObject({ status: "uncertain", stage: "execute", cause: LOST, observations: [{ kind: "agent", target: seen.created, confirmed: false }] });
});

test("cause C: an authorize-stage refusal keeps its cause and leaves no receipt", async () => {
  const { agents, chats, requests } = world([[call("launch_agent", { ...LAUNCH, project: "project-does-not-exist" })], [message("Reported.")]]);
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  expect(toolResult(requests)).toEqual({ error: "Choose a current authorized project.", operation: "launch_agent", status: "failed", stage: "request", retry: "safe" });
  expect(agents.list()).toHaveLength(0);
  expect(chats.actionReceipts(session.id).receipts).toEqual([]);
});

test("cause D: a receipt-write failure before execution reports its own cause and never starts a worker", async () => {
  const root = vault(), actions = new ApplicationActions(root, { write() { throw new Error("Fabricated receipt storage failure."); } });
  const { agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]], { actions, root });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  expect(toolResult(requests)).toEqual({ error: "Fabricated receipt storage failure.", operation: "launch_agent", status: "failed", stage: "request", retry: "safe" });
  expect(agents.list()).toHaveLength(0);
});

test("retry: the same call in the same turn resolves to the worker it already created", async () => {
  const seen = { attempts: 0 } as { created?: string; attempts: number };
  const { agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [call("launch_agent", LAUNCH)], [message("Reported.")]], { external: (a: AgentOrchestrator) => lossy(a, seen) });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const [first, second] = toolResults(requests) as Record<string, unknown>[];
  expect(first).toMatchObject({ status: "unknown", retry: "blocked", agent: seen.created });
  expect(second).toMatchObject({ id: seen.created, title: "Fabricated task" });
  expect(seen.attempts).toBe(1);
  expect(agents.list()).toHaveLength(1);
  expect(chats.actionReceipts(session.id).receipts).toMatchObject([{ status: "completed", observations: [{ kind: "agent", target: seen.created, confirmed: true }] }]);
});

test("a retry of a pre-effect refusal with the same identity runs again once it can succeed", async () => {
  const { agents, chats } = world([]);
  const session = chats.create([]);
  session.messages.push({ id: "fabricated-user-message", role: "user", text: "Start a worker", at: new Date().toISOString() });
  const occupied = Array.from({ length: 4 }, (_, i) => agents.launch("pilot-other", "message", { ...LAUNCH, title: `Occupied ${i}`, cwd: dir(), mode: "work" }, []));
  const refused = await (chats as any).tool(session, "launch_agent", LAUNCH, new AbortController().signal);
  expect(refused).toMatchObject({ status: "failed", retry: "safe" });
  await agents.interrupt(occupied[0]!.id);
  const launched = await (chats as any).tool(session, "launch_agent", LAUNCH, new AbortController().signal);
  expect(launched.id).toMatch(/^work-[a-f0-9]{32}$/);
  expect(chats.actionReceipts(session.id).receipts).toMatchObject([{ id: refused.request, status: "completed" }]);
});

test("visibility: a later turn is shown the unresolved request and its possible worker", async () => {
  const seen = { attempts: 0 } as { created?: string; attempts: number };
  const { chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")], [message("Later turn.")]], { external: (a: AgentOrchestrator) => lossy(a, seen) });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  await turn(chats, session.id, "What happened to it?", "fabricated-input-2");
  const receipt = chats.actionReceipts(session.id).receipts[0] as any;
  // Only the newest user turn, not the replayed thread history.
  const later = JSON.stringify(requests.at(-1)!.input.at(-1));
  expect(later).toContain("External agents owned by this Pilot");
  expect(later).toContain("Unresolved application actions");
  expect(later).toContain(receipt.id);
  expect(later).toContain(seen.created!);
});

test("read_action: Pilot reads its own request and the agent it created; another Pilot cannot", async () => {
  const seen = { attempts: 0 } as { created?: string; attempts: number };
  const { chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]], { external: (a: AgentOrchestrator) => lossy(a, seen) });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const { request } = toolResult(requests) as { request: string };
  const read = (s: unknown, args: unknown) => (chats as any).tool(s, "read_action", args, new AbortController().signal);
  const own = await read(session, { request });
  expect(own).toMatchObject({ action: { id: request, operation: "launch_agent", status: "completed", cause: LOST }, agent: { id: seen.created, title: "Fabricated task" } });
  expect((await read(session, {})).actions.map((a: any) => a.id)).toEqual([request]);
  const other = chats.create([]);
  expect(await read(other, { request })).toMatchObject({ error: "No action with that request ID belongs to this Pilot." });
  expect(JSON.stringify(await read(other, {}))).not.toContain(request);
});

test("restart: an uncertain launch settles to its recorded worker without replaying anything", async () => {
  const seen = { attempts: 0 } as { created?: string; attempts: number };
  const { root, agents, chats } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]], { external: (a: AgentOrchestrator) => lossy(a, seen) });
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  chats.close(); agents.close();

  const restartedAgents = orchestrator(root);
  const restarted = new PilotChats(root, { graph: () => [], external: lossy(restartedAgents, seen), fetch: scripted([[message("Reported.")]]) });
  cleanups.push(() => restarted.close());
  const receipts = restarted.actionReceipts(session.id).receipts as any[];
  expect(receipts[0]).toMatchObject({ operation: "launch_agent", status: "completed", stage: "execute", cause: LOST });
  expect(receipts[0].observations).toEqual([{ kind: "agent", target: seen.created, confirmed: true }]);
  // Re-delivering the same request resolves to the same worker.
  const again = await (restarted as any).tool(restarted.get(session.id), "launch_agent", LAUNCH, new AbortController().signal);
  expect(again.id).toBe(seen.created);
  expect(seen.attempts).toBe(1);
  expect(restartedAgents.list().map(j => j.id)).toEqual([seen.created!]);
});

test("cause E: a worker-record write failure never leaves a live worker no roster can see", async () => {
  const { root, agents, chats, requests } = world([[call("launch_agent", LAUNCH)], [message("Reported.")]]);
  // Fabricated durable-storage failure for the worker record only.
  const workers = join(root, ".spool", "workers");
  mkdirSync(workers, { recursive: true });
  chmodSync(workers, 0o500);
  cleanups.push(() => chmodSync(workers, 0o700));
  const session = chats.create([]);
  await turn(chats, session.id, "Start a worker", "fabricated-input-1");
  const result = toolResult(requests) as Record<string, unknown>;
  // A write may land before it reports failure, so the verdict stays unknown.
  expect(result).toMatchObject({ error: AMBIGUOUS, status: "unknown", stage: "execute", retry: "blocked" });
  expect(result.agent).toBeUndefined();
  expect(agents.list()).toHaveLength(0);
  expect(readdirSync(workers)).toHaveLength(0);
  chats.close(); agents.close();
  chmodSync(workers, 0o700);
  const restartedAgents = orchestrator(root);
  const restarted = new PilotChats(root, { graph: () => [], external: restartedAgents });
  cleanups.push(() => restarted.close());
  expect(restartedAgents.list()).toHaveLength(0);
  // No worker record: the request stays unknown and is never relaunched.
  expect(restarted.actionReceipts(session.id).receipts).toMatchObject([{ status: "uncertain", stage: "execute" }]);
});
