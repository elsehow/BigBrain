#!/usr/bin/env bun
import { ConnectedClients, ConnectionExpired, authenticateClient } from "../lib/connectedClients";
/** Local public MCP server; config prints setup JSON, memory supports startup hooks. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requireVaultRoot } from "../lib/engine";
import { handleMcpTool, MCP_INSTRUCTIONS, McpToolError, mcpToolList, type McpContext } from "../lib/mcp";
import { registerMcpClients } from "../lib/mcpRegister";
import { flagValue, flagValues, hasFlag, positionals } from "../lib/cliflags";

const argv = process.argv.slice(2);
const [sub] = positionals(argv, new Set(["client", "connection"]));

if (hasFlag(argv, "gardener")) {
  console.error("mcp: maintenance tools are internal; use bigbrain tend for gardening.");
  process.exit(2);
}
if (sub === "config") {
  const clients = new ConnectedClients(requireVaultRoot());
  const setup = flagValue(argv,"client") ? clients.setup(flagValue(argv,"client")!) : clients.ensure("Local MCP configuration","generic","cli:config");
  console.log(JSON.stringify(setup.configuration, null, 2));
  process.exit(0);
}
if (sub === "memory") {
  console.log(handleMcpTool({ root: requireVaultRoot(), via: "cli" }, "load_memory"));
  process.exit(0);
}
if (sub === "register") {
  const root = requireVaultRoot();
  const only = flagValues(argv, "client").filter(Boolean);
  const results = registerMcpClients(root, { only, entry: target => new ConnectedClients(root).ensure(target.label,"generic",`registered:${target.key}`).configuration.mcpServers.bigbrain });
  let failed = false;
  for (const r of results) {
    if (r.status === "registered") console.log(`  ${r.label}: registered → ${r.path}`);
    else if (r.status === "not-installed") console.log(`  ${r.label}: not installed, skipped`);
    else {
      failed = true;
      console.error(`  ${r.label}: ERROR — ${r.detail} (${r.path})`);
    }
  }
  if (results.every((r) => r.status === "not-installed"))
    console.log("no MCP clients found — install Claude Desktop, Cursor, or Windsurf and re-run");
  else if (!failed) console.log("restart the client(s) to pick up the new server");
  process.exit(failed ? 1 : 0);
} else if (sub) {
  console.error(`mcp: unknown subcommand ${JSON.stringify(sub)} — serve (no args), config, memory, or register`);
  process.exit(2);
}

const via = "cli" as const;

const root = requireVaultRoot();

const connection = flagValue(argv, "connection");
if (connection && !["claude-plugin", "codex-plugin", "local-config"].includes(connection)) throw new Error("Unknown client configuration.");
const clientId = flagValue(argv, "client") ?? (connection ? new ConnectedClients(root).ensure(connection === "claude-plugin" ? "Claude Code plugin" : connection === "codex-plugin" ? "Codex plugin" : "Local MCP configuration", connection === "claude-plugin" ? "claude-code" : connection === "codex-plugin" ? "codex" : "generic", connection).id : undefined);
const credential = () => clientId ? new ConnectedClients(root).token(clientId) : undefined;
const authorized = (scope = "vault:read") => authenticateClient(root, credential(), scope);

const server = new Server(
  { name: "bigbrain", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
);

// The initialized notification confirms a client completed the MCP handshake.
// Do not wait for tool discovery/use to retire a pending legacy replacement.
// A lapsed connection stays up, serving nothing: every tool answers with
// where to renew it, which a closed server could never tell the agent.
server.oninitialized = () => {
  try { authorized(); }
  catch (error) {
    if (error instanceof ConnectionExpired) { console.error("mcp:", error.message); return; }
    console.error("mcp: connection authentication failed:", error);void server.close();
  }
};

server.setRequestHandler(ListToolsRequestSchema, () => {
  try { authorized(); } catch (error) { if (!(error instanceof ConnectionExpired)) throw error; }
  return { tools: mcpToolList({root,via,integrationToken:credential()}) };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
  const identity = authorized(req.params.name === "drop" ? "inbox:write" : "vault:read");
  const ctx: McpContext = {
    root,
    via,
    integrationToken: credential(),
    clientName: identity.name,
  };
    const result = await handleMcpTool(ctx, req.params.name, req.params.arguments);
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (error instanceof McpToolError || error instanceof ConnectionExpired)
      return { content: [{ type: "text", text: error.message }], isError: true };
    // Unexpected: still the tool's failure, not the server's — answer the
    // call (a crash would kill every other tool in the session).
    console.error(`mcp: ${req.params.name} failed:`, error);
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
console.error(`bigbrain mcp: serving ${root} over stdio (via=${via})`);
