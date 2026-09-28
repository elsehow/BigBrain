#!/usr/bin/env bun
/** A project worker's explicit vault connection: readers and evidence drops.
 * Curator tools are intentionally absent. The ordinary agent environment is
 * retained; this connection identifies which vault the task is discussing. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requireVaultRoot } from "../lib/engine";
import { VAULT_TOOLS, handleVaultTool } from "../lib/vaultTools";
import { recordWorkOutput } from "../lib/workOutputs";
import { workSessionId } from "../lib/env";

const root = requireVaultRoot();
const tools = VAULT_TOOLS.filter(t => ["load_memory", "search_vault", "read_note", "drop"].includes(t.name));
const server = new Server({ name: "bigbrain_current", version: "1.0.0" }, { capabilities: { tools: {} },
  instructions: `This connection serves the current task vault: ${JSON.stringify(root)}. Results include its identity. Drop saves evidence or a kind=request work order for the curator; it does not directly edit the graph.` });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    if (!tools.some(t => t.name === req.params.name)) throw new Error("This worker can read and drop evidence; it cannot curate the vault");
    const result = await handleVaultTool({ root, via: "web", clientName: "pilot-worker" }, req.params.name, req.params.arguments ?? {});
    const work = workSessionId();
    if (req.params.name === "drop" && work) {
      recordWorkOutput(root, work, result as { id: string; path: string }, String(req.params.arguments?.title ?? "Worker output"));
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ vault: root, result }) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ vault: root, error: e instanceof Error ? e.message : "Vault request failed" }) }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
