/** Internal transport for legacy injected Claude jobs. Not registered with external clients. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requireVaultRoot } from "../lib/engine";
import { machineTools } from "../lib/run/machineTools";

const tools = machineTools(requireVaultRoot(), "tend", false, "claude");
const server = new Server({ name: "bigbrain", version: "1.0.0" }, { capabilities: { tools: {} },
  instructions: "File arrivals with next, open and submit. Search and read the supporting record. Memory maintenance is a separate role." });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const tool = tools.find(t => t.name === request.params.name);
    if (!tool) throw new Error(`no such tool: ${request.params.name}`);
    const result = await tool.call(request.params.arguments ?? {});
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
});
await server.connect(new StdioServerTransport());
