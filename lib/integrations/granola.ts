/** Granola meeting notes, read through Granola's own MCP server with the
 * person's sign-in (lib/granolaMcp.ts). Its read tools are discovered upstream,
 * so agents get a fixed pair: granola_tools lists them, granola_read calls one. */
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { GRANOLA_READ_TOOLS, granolaConnection, withGranola } from "../granolaMcp";
import { readEnvValues } from "../envFile";
import { sha256hex } from "../hash";
import { upstreamForAgent, upstreamToolsForAgent } from "../agentReads";
import { accountEnvKey, extraAccounts, policyPath, tool, type Integration, type ToolContext } from "./contract";

/** The most a granola_read call may pass upstream, as JSON. */
const ARGUMENTS_CAP = 16_000;

/** `args` against the upstream tool's own input schema, when zod can read it; any schema at least gets an object of bounded size. */
function upstreamArguments(t: Tool, args: Record<string, unknown>): Record<string, unknown> {
  let schema: z.ZodType | undefined;
  try { schema = z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]); } catch { return args; }
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(`These arguments don't fit ${t.name}: ${parsed.error.issues.map(i => (i.path.join(".") || "arguments") + ": " + i.message).join("; ")}. Check its schema with granola_tools.`);
  return args;
}

/** One signed-in session with Granola's read tools, re-authorized once they are listed. */
const upstream = <T>(ctx: ToolContext, fn: (client: Client, reads: Tool[]) => Promise<T>): Promise<T> =>
  withGranola(ctx.root, ctx.account, async (client, tools) => {
    const reads = tools.filter(t => GRANOLA_READ_TOOLS.has(t.name));
    ctx.authorize(); ctx.signal.throwIfAborted();
    return fn(client, reads);
  }, { ...ctx.options.granola, signal: ctx.signal });

export const granola: Integration = {
  id: "granola",
  name: "Granola",
  library: { description: "Bring your meeting transcripts into your vault.",
    added: root => existsSync(policyPath(root, "granola", "granola")) || extraAccounts(root, "granola").length > 0 || !!readEnvValues(root).GRANOLA_API_KEY },
  origin: "granola",
  // envKey: the retired API key, still part of a legacy activation's fingerprint
  credential: { kind: "oauth", envKey: a => accountEnvKey("GRANOLA_API_KEY", "granola", a), signedIn: (root, a) => !!granolaConnection(root, a) },
  accounts: root => ["granola", ...extraAccounts(root, "granola").map(a => a.id)],
  fingerprint: (root, account) => sha256hex(JSON.stringify([account, granolaConnection(root, account)?.generation ?? "disconnected"])),
  live: { read: "Read current meeting notes, transcripts and folders via Granola MCP. Does not change meetings or remember evidence.", write: null },
  tools: [
    tool({ name: "granola_tools", access: "read", reads: "your Granola notes",
      description: "Discover current Granola MCP read tools and their input schemas for one granted account. Reads do not remember evidence.",
      input: z.object({ account: z.string() }),
      run: ctx => upstream(ctx, async (_client, reads) => reads),
      // upstream descriptions are Granola's words, not BigBrain's
      forAgent: result => upstreamToolsForAgent("granola", result) }),
    tool({ name: "granola_read", access: "read", reads: "your Granola notes",
      description: "Call a Granola read tool using the exact name and arguments returned by granola_tools. Reads current meeting notes, transcripts or folders; does not change meetings or remember evidence.",
      input: z.object({ account: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown())
        .refine(a => JSON.stringify(a).length <= ARGUMENTS_CAP, `Keep the arguments under ${ARGUMENTS_CAP} characters.`) }),
      run: (ctx, args) => upstream(ctx, async (client, reads) => {
        const read = reads.find(t => t.name === args.tool);
        if (!read) throw Error("Choose an available Granola read tool.");
        return client.callTool({ name: read.name, arguments: upstreamArguments(read, args.arguments) }, undefined, { signal: ctx.signal });
      }),
      forAgent: result => upstreamForAgent("granola", result) }),
  ],
};
