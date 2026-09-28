import { ConnectedClients } from "../lib/connectedClients";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpServerEntry } from "../lib/mcpRegister";
import { join } from "node:path";
import { nativeVault } from "./support/vault";

test("an explicitly configured MCP connection uses its pinned vault even from another vault's cwd", async () => {
  const root = nativeVault({ files: { "memory/MEMORY.md": "# Preview memory\nTHE_PREVIEW_ONLY_MARKER\n" } });
  const other = nativeVault({ files: { "memory/MEMORY.md": "# Other memory\nTHE_OTHER_ONLY_MARKER\n" } });
  const config = mcpServerEntry(root, other);
  const store=join(root,".tokens"), clients=new ConnectedClients(root,store), setup=clients.create({name:"offline-worker",kind:"generic"});
  config.env.BIGBRAIN_TOKENS=store;config.env.BIGBRAIN_MCP_TOKEN=clients.token(setup.id);
  const client = new Client({ name: "offline-worker", version: "1" });
  const transport = new StdioClientTransport({ ...config, cwd: other, stderr: "ignore", env: { PATH: process.env.PATH ?? "", ...config.env } });
  try {
    await client.connect(transport);
    const result = JSON.stringify(await client.callTool({ name: "load_memory", arguments: {} }));
    expect(result).toContain("THE_PREVIEW_ONLY_MARKER");
    expect(result).not.toContain("THE_OTHER_ONLY_MARKER");
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toContain("drop");
    expect(tools.tools.map(t => t.name)).not.toContain("submit");
    const dropped = await client.callTool({ name: "drop", arguments: { title: "Test findings", body: "Offline findings for the preview vault." } });
    expect(dropped.isError).not.toBe(true);
    const receipt = JSON.parse((dropped.content as { text: string }[])[0]!.text);
    expect(readFileSync(join(root, receipt.path), "utf8")).toContain("Offline findings for the preview vault.");
    expect(existsSync(join(other, receipt.path))).toBe(false);
    expect((await client.callTool({ name: "submit", arguments: {} })).isError).toBe(true);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});
