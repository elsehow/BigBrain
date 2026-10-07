/** One account-scoped dispatch boundary shared by Pilot, gardener and MCP:
 * every live tool call passes through dispatchIntegrationTool, whoever makes
 * it. The tools are the registry's (lib/integrations/); this decides whether a
 * call is one of them, with what arguments, on which account, for which caller,
 * and tells its observers how each call ended. */
import { integrationCallerId, writableIntegrationAccounts, readableIntegrationAccounts, requireIntegrationWrite, requireIntegrationRead, type IntegrationCaller } from "./integrationAccess";
import { INTEGRATIONS, integrationNamed, integrationTool, liveOrigin, type Integration, type IntegrationCallOptions, type IntegrationTool } from "./integrations";

export type { IntegrationCallOptions } from "./integrations";

/** Every live tool agents are offered: discovery, then each integration's own. */
export const INTEGRATION_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown>; access: "read" | "write" }[] = [
  {name:"integration_capabilities", description:"List the live source accounts this caller can read. This does not read source content or save evidence.", inputSchema:{type:"object",properties:{},additionalProperties:false}, access:"read"},
  ...INTEGRATIONS.flatMap(i => i.tools.map(({ name, description, inputSchema, access }) => ({ name, description, inputSchema, access }))),
];
function capabilities(root: string, i: Integration, caller: IntegrationCaller) {
  const accounts = readableIntegrationAccounts(root, i.id, caller), available = accounts.length > 0;
  const reads = i.tools.filter(t => t.access === "read").map(t => t.name), writes = i.tools.filter(t => t.access === "write").map(t => t.name);
  if (!writes.length) return { accounts, available, descriptors: i.live, operations: reads };
  const writable = writableIntegrationAccounts(root, i.id, caller);
  return { accounts, descriptors: i.live, accountAccess: accounts.map(account => ({ account, access: writable.includes(account) ? "read-write" : "read" })), available,
    operations: [...reads, ...(writable.length > 0 ? writes : [])], access: "Per-account grants; write operations require read+write" };
}
export function integrationCapabilities(root: string, caller: IntegrationCaller) {
  return { ...Object.fromEntries(INTEGRATIONS.filter(i => i.tools.length).map(i => [i.id, capabilities(root, i, caller)])),
    remembering: "Live reads do not save evidence. Use drop explicitly; the gardener owns admission and filing." };
}
/** One live tool call as it ended. */
export interface IntegrationCall {
  /** When it began. */
  at: string;
  /** Who asked, as grants name them (`pilot`, `token:<id>`), or the caller's kind when it could not be identified. */
  caller: string;
  integration: string;
  /** Empty when it was refused before an account was resolved. */
  account: string;
  tool: string;
  /** As validated, or as given when they were refused. */
  args: Record<string, unknown>;
  /** refused: BigBrain said no (not the integration's tool, arguments it doesn't declare, no access, access withdrawn mid-call); error: the call itself failed. */
  outcome: "ok" | "refused" | "error";
  error?: string;
  ms: number;
  /** What the agent received, to measure; never to keep. */
  result?: unknown;
}
const observers = new Set<(call: IntegrationCall) => void>();
/** Hear every live tool call once it ends; returns the way to stop. An observer that throws never fails the call. */
export function observeIntegrationCalls(observer: (call: IntegrationCall) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** What a content read's results are, for the provenance every agent-facing result carries (lib/agentReads.ts). */
const origin = (name: string) => { const kind = liveOrigin(name); return kind ? { kind, trusted: false } : {}; };
const issue = (i: { code: string; path: PropertyKey[]; message: string; keys?: string[] }) =>
  i.code === "unrecognized_keys" ? `${i.keys!.join(", ")} ${i.keys!.length > 1 ? "are" : "is"} not an argument it takes` : `${i.path.join(".") || "arguments"}: ${i.message}`;
/** Arguments as the tool declares them, or a refusal that says what is wrong. An absent optional may arrive as null; some models send it so. */
function validated(tool: IntegrationTool, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = tool.input.safeParse(Object.fromEntries(Object.entries(args).filter(([k, v]) => !(v === null && k in tool.input.shape))));
  if (!parsed.success) throw new Error(`Invalid arguments for ${tool.name}: ${parsed.error.issues.map(issue).join("; ")}.`);
  return parsed.data;
}
/** The account a call reads: the one its ref names, else the one it names, else the caller's only readable one. A ref and a named account must agree. */
function accountFor(root: string, caller: IntegrationCaller, integration: Integration, args: Record<string, unknown>): string {
  const said = typeof args.account === "string" && args.account ? args.account : undefined;
  const named = said && (integration.accounts(root).find(a => a.toLowerCase() === said.toLowerCase()) ?? said);
  const referred = typeof args.ref === "string" && integration.refAccount ? integration.refAccount(args.ref) : undefined;
  if (named && referred !== undefined && named !== referred) throw new Error("That ref belongs to a different account than the one named; omit account, or use a ref from that account.");
  const chosen = referred ?? named;
  if (chosen) return chosen;
  const readable = readableIntegrationAccounts(root, integration.id, caller);
  if (readable.length === 1) return readable[0]!;
  throw new Error(readable.length ? `Name the ${integration.name} account to read: ${readable.join(", ")}.` : "This account is not available to this caller. Update access in Settings → Integrations.");
}

export async function integrationToolCall(root: string, caller: IntegrationCaller, name: string, args: Record<string, unknown>, options: IntegrationCallOptions = {}): Promise<unknown> {
  if (name === "integration_capabilities") return integrationCapabilities(root, caller);
  const found = integrationTool(name);
  if (!found) throw new Error("This integration operation is not available.");
  return dispatchIntegrationTool(root, caller, found.integration.id, name, args, options);
}

/** Run one of an integration's own tools for a caller: arguments as it declares
 * them, the account resolved here, and the caller's access to it (write access
 * for a write) checked before, every 100ms during, and after the provider's
 * work, which is aborted the moment access is withdrawn. */
export async function dispatchIntegrationTool(root: string, caller: IntegrationCaller, integrationId: string, name: string, args: Record<string, unknown>, options: IntegrationCallOptions = {}): Promise<unknown> {
  const call: IntegrationCall = { at: new Date().toISOString(), caller: caller.kind, integration: integrationId, account: "", tool: name, args, outcome: "refused", ms: 0 };
  const started = performance.now();
  let refused = true;
  try {
    call.caller = integrationCallerId(root, caller); // a caller that can't read live accounts at all hears that first
    const integration = integrationNamed(integrationId), tool = integration?.tools.find(t => t.name === name);
    if (!integration || !tool) throw new Error(`${name} is not ${integration ? "a " + integration.name : "an integration"} tool.`);
    const given = call.args = validated(tool, args);
    const account = call.account = accountFor(root, caller, integration, given);
    const required = tool.access === "write" ? requireIntegrationWrite : requireIntegrationRead;
    const check = () => { try { required(root, integration.id, account, caller); } catch (error) { refused = true; throw error; } };
    check(); options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setInterval(() => { try { check(); } catch { controller.abort(); } }, 100);
    timer.unref?.();
    try {
      refused = false;
      const result = await tool.run({ root, account, signal, authorize: check, options }, given);
      try { check(); signal.throwIfAborted(); } catch (error) { if (tool.access === "write") throw new Error("Access changed after the provider operation, which may have applied; inspect current state before retrying."); throw error; }
      const out = { provenance: { integration: integration.id, account, scope: "live_source", checkedAt: new Date().toISOString(), remembered: false, ...origin(name) }, result: tool.forAgent ? tool.forAgent(result) : result };
      call.outcome = "ok"; call.result = out;
      return out;
    } finally { clearInterval(timer); }
  } catch (error) {
    call.outcome = refused ? "refused" : "error";
    call.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    call.ms = Math.round(performance.now() - started);
    for (const observe of observers) try { observe(call); } catch { /* the call already ended */ }
  }
}
