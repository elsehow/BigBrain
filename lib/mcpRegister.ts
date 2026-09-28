/** Local MCP configuration for external clients. Plugins use the same public
 * server; standalone configurations pin a vault explicitly. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDev, tokenStore } from "./env";
import { ENGINE_ROOT } from "./engine";

export interface McpClientTarget {
  key: string;
  label: string;
  /** Config file path, given a home directory. */
  configPath: (home: string) => string;
  /** The directory whose existence means "installed". */
  probeDir: (home: string) => string;
}

export const MCP_CLIENTS: McpClientTarget[] = [
  {
    key: "claude-desktop",
    label: "Claude Desktop",
    configPath: (home) => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    probeDir: (home) => join(home, "Library", "Application Support", "Claude"),
  },
  {
    key: "cursor",
    label: "Cursor",
    configPath: (home) => join(home, ".cursor", "mcp.json"),
    probeDir: (home) => join(home, ".cursor"),
  },
  {
    key: "windsurf",
    label: "Windsurf",
    configPath: (home) => join(home, ".codeium", "windsurf", "mcp_config.json"),
    probeDir: (home) => join(home, ".codeium", "windsurf"),
  },
];

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The server entry a client should launch for this vault. */
export function mcpServerEntry(vault: string, home: string = homedir()): McpServerEntry {
  const installed = join(home, ".local", "bin", "bigbrain");
  const [command, ...args] = !isDev() && existsSync(installed)
    ? [installed, "mcp"]
    : [process.execPath, join(ENGINE_ROOT, "bin", "cli.ts"), "mcp"];
  return { command: command!, args, env: { BIGBRAIN_VAULT: vault, ...(tokenStore() ? {BIGBRAIN_TOKENS:tokenStore()!} : {}) } };
}

export interface RegisterResult {
  key: string;
  label: string;
  path: string;
  status: "registered" | "not-installed" | "error";
  detail?: string;
}

/** Register one client: read (or start empty), merge, write, re-read. */
function registerOne(target: McpClientTarget, entry: McpServerEntry, home: string): RegisterResult {
  const path = target.configPath(home);
  const base = { key: target.key, label: target.label, path };
  if (!existsSync(target.probeDir(home))) return { ...base, status: "not-installed" };
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { ...base, status: "error", detail: "existing config is not a JSON object — fix it by hand" };
      config = parsed as Record<string, unknown>;
    }
    const servers =
      config["mcpServers"] && typeof config["mcpServers"] === "object" && !Array.isArray(config["mcpServers"])
        ? (config["mcpServers"] as Record<string, unknown>)
        : {};
    servers["bigbrain"] = entry;
    config["mcpServers"] = servers;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    // Verify: the write must read back as JSON with our entry present.
    const back = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (!back.mcpServers?.["bigbrain"]) return { ...base, status: "error", detail: "verify failed — entry missing after write" };
    return { ...base, status: "registered" };
  } catch (error) {
    return { ...base, status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Register every installed client (or the `only` subset). */
export function registerMcpClients(
  vault: string,
  opts: { home?: string; only?: readonly string[]; entry?: (target:McpClientTarget)=>McpServerEntry } = {}
): RegisterResult[] {
  const home = opts.home ?? homedir();
  const entry = mcpServerEntry(vault, home);
  const targets = opts.only?.length
    ? MCP_CLIENTS.filter((c) => opts.only!.includes(c.key))
    : MCP_CLIENTS;
  return targets.map((t) => registerOne(t, existsSync(t.probeDir(home)) && opts.entry ? opts.entry(t) : entry, home));
}
