/** One account-scoped dispatch boundary shared by Pilot, gardener and MCP.
 * The tools are the registry's (lib/integrations/); this decides who may call them. */
import { writableIntegrationAccounts, readableIntegrationAccounts, requireIntegrationWrite, requireIntegrationRead, type IntegrationCaller } from "./integrationAccess";
import { INTEGRATIONS, integrationTool, liveOrigin, type Integration, type IntegrationCallOptions } from "./integrations";
import { mailRefAccount } from "./integrations/email";

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
/** What a content read's results are, for the provenance every agent-facing result carries (lib/agentReads.ts). */
const origin = (name: string) => { const kind = liveOrigin(name); return kind ? { kind, trusted: false } : {}; };
export async function integrationToolCall(root: string, caller: IntegrationCaller, name: string, args: Record<string, unknown>, options: IntegrationCallOptions = {}): Promise<unknown> {
  if (name === "integration_capabilities") return integrationCapabilities(root, caller);
  const found = integrationTool(name);
  if (!found) throw new Error("This integration operation is not available.");
  const { integration, tool } = found;
  // Granola is named outright; mail by its ref, or else the sole readable inbox.
  let account = integration.id === "granola" ? String(args.account ?? "") : typeof args.account === "string" ? args.account.toLowerCase() : "";
  if (integration.id === "email") {
    if ("ref" in tool.input.shape) account = mailRefAccount(args.ref) as string;
    if (!account) {
      const accounts = readableIntegrationAccounts(root, "email", caller);
      if (accounts.length === 1) account = accounts[0]!;
    }
  }
  const check = () => tool.access === "write" ? requireIntegrationWrite(root, integration.id, account, caller) : requireIntegrationRead(root, integration.id, account, caller);
  check(); options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setInterval(() => { try { check(); } catch { controller.abort(); } }, 100);
  timer.unref?.();
  try {
    const result = await tool.run({ root, account, signal, authorize: check, options }, args);
    try { check(); signal.throwIfAborted(); } catch(error) { if(tool.access==="write")throw new Error("Access changed after the provider operation. The flag may have changed; inspect current state before retrying.");throw error; }
    return { provenance: { integration: integration.id, account, scope: "live_source", checkedAt: new Date().toISOString(), remembered: false, ...origin(name) }, result: tool.forAgent ? tool.forAgent(result) : result };
  } finally { clearInterval(timer); }
}
