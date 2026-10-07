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
import { upstreamForAgent } from "../agentReads";
import { accountEnvKey, extraAccounts, policyPath, tool, type Integration, type ToolContext } from "./contract";

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
      input: z.strictObject({ account: z.string() }),
      run: ctx => upstream(ctx, async (_client, reads) => reads) }),
    tool({ name: "granola_read", access: "read", reads: "your Granola notes", material: true,
      description: "Call a Granola read tool using the exact name and arguments returned by granola_tools. Reads current meeting notes, transcripts or folders; does not change meetings or remember evidence.",
      input: z.strictObject({ account: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }),
      run: (ctx, args) => upstream(ctx, async (client, reads) => {
        if (!reads.some(t => t.name === args.tool)) throw Error("Choose an available Granola read tool.");
        if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw Error("Provide the tool arguments.");
        return client.callTool({ name: String(args.tool), arguments: args.arguments as Record<string, unknown> }, undefined, { signal: ctx.signal });
      }),
      forAgent: result => upstreamForAgent("granola", result) }),
  ],
};
