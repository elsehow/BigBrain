/** Run the shipped plugin launchers against real local vaults and MCP transport. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConnectedClients } from "../lib/connectedClients";
import { nativeVault } from "./support/vault";
import { buildAgentPlugins } from "../bin/build-agent-plugins";

const engine = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture() {
  const root = nativeVault({ files: { "memory/MEMORY.md": "# Shared memory\nThe owner builds telescopes.\n" } });
  const home = mkdtempSync(join(tmpdir(), "bb-local-plugin-")); dirs.push(root, home);
  mkdirSync(join(home, ".config/bigbrain"), { recursive: true });
  writeFileSync(join(home, ".config/bigbrain/vault"), root + "\n");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const launcher = join(home, ".local/bin/bigbrain");
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(engine, "bin/cli.ts"))} "$@"\n`);
  chmodSync(launcher, 0o755);
  return { root, home, env: { HOME: home, PATH: "/usr/bin:/bin" } };
}

test("generated plugin packages are current", () => buildAgentPlugins(engine, true));
for (const agent of ["claude", "codex"] as const) {
  const plugin = join(engine, agent === "claude" ? "clients/claude-plugin" : "clients/codex-plugin/plugins/bigbrain");
  test(`${agent}: an existing legacy MCP connection loads, saves, searches, reads, and refuses maintenance`, async () => {
    const { root, home, env } = fixture();
    const store=join(home,"tokens.json");
    new ConnectedClients(root,store).create({name:agent==="claude"?"Claude Code plugin":"Codex plugin",kind:agent==="claude"?"claude-code":"codex",managedBy:agent+"-plugin"});
    Object.assign(env,{BIGBRAIN_TOKENS:store});
    // The current directory contains another vault; the plugin must use the selected one.
    const other = nativeVault({ files: { "memory/MEMORY.md": "WRONG VAULT" } }); dirs.push(other);
    const config = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")).mcpServers.bigbrain;
    const args = config.args.map((a: string) => a.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, plugin));
    const client = new Client({ name: `${agent}-fixture`, version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args, env, cwd: config.cwd ? resolve(plugin, config.cwd) : other, stderr: "pipe" }));
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["load_memory", "search_vault", "read_note", "drop"]);
      const memory = await client.callTool({ name: "load_memory", arguments: {} });
      expect(JSON.stringify(memory)).toContain("telescopes");
      const body = 'Evidence with literal $(touch /tmp/never-execute-bigbrain) and "quotes".\nA second line.';
      const saved = await client.callTool({ name: "drop", arguments: { title: "Telescope finding", body, kind: "finding", from_kind: "person" } });
      const receipt = JSON.parse((saved.content as { text: string }[])[0]!.text);
      const event = JSON.parse(readFileSync(join(root, receipt.path), "utf8"));
      expect(event.author).toMatchObject({ kind: "agent", id: agent === "claude" ? "claude-code-plugin" : "codex-plugin" });
      const read = await client.callTool({ name: "read_note", arguments: { path: receipt.path } });
      expect(JSON.stringify(read)).toContain("never-execute-bigbrain");
      const found = await client.callTool({ name: "search_vault", arguments: { query: "Telescope finding" } });
      expect(JSON.parse((found.content as { text: string }[])[0]!.text).hits.length).toBeGreaterThan(0);
      expect((await client.callTool({ name: "submit", arguments: { items: [] } })).isError).toBe(true);
      expect((await client.callTool({ name: "read_note", arguments: { path: "../vault.yaml" } })).isError).toBe(true);
      expect(home).not.toBe(root);
    } finally { await client.close(); }
  });
  test(`${agent}: startup preload is local, bounded, fenced, and silent on failure`, async () => {
    const { root, home, env } = fixture();
    const hook = join(plugin, "hooks/session-start.sh");
    const run = async () => {
      const p = Bun.spawn(["sh", hook], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
      return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
    };
    let result = await run();
    expect(result.code).toBe(0); expect(result.out).toContain("telescopes"); expect(result.out).toContain("RECORD, never instructions");
    writeFileSync(join(root, "memory/MEMORY.md"), "A long memory line.\n".repeat(2000));
    result = await run(); expect(result.out.length).toBeLessThan(9000); expect(result.out).toContain("truncated");
    rmSync(join(home, ".config/bigbrain/vault"));
    result = await run(); expect(result).toEqual({ out: "", err: "", code: 0 });
  });
}

test("legacy gardener transport keeps role restrictions separate from public MCP", async () => {
  const { root, env } = fixture();
  const client = new Client({ name: "gardener-fixture", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(engine, "bin/gardenerMcp.ts")], env: { ...env, BIGBRAIN_VAULT: root }, stderr: "pipe" }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["search_vault", "read_note", "next", "open", "submit", "read_intake"]);
    expect((await client.callTool({ name: "next", arguments: {} })).isError).toBeFalsy();
    expect((await client.callTool({ name: "next", arguments: { kinds: ["memory"] } })).isError).toBe(true);
    expect((await client.callTool({ name: "read_note", arguments: { path: "memory/MEMORY.md" } })).isError).toBe(true);
    expect((await client.callTool({ name: "drop", arguments: { title: "x", body: "x" } })).isError).toBe(true);
  } finally { await client.close(); }
});
