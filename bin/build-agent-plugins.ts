#!/usr/bin/env bun
/** Deterministic shared skills/scripts renderer. Generated packages are
 * committed and carried by the desktop bundle; --check catches drift in CI. */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";

export function buildAgentPlugins(root = ENGINE_ROOT, check = false): void {
  const outputs = new Map<string, string>();
  const version = "0.1.24";
  for (const agent of ["claude", "codex"] as const) {
    const target = agent === "claude" ? "clients/claude-plugin" : "clients/codex-plugin/plugins/bigbrain";
    const hookRoot = agent === "claude" ? "${CLAUDE_PLUGIN_ROOT}" : "${PLUGIN_ROOT}";
    const vars: Record<string, string> = {
      ROOT_ENV: agent === "claude" ? "CLAUDE_PLUGIN_ROOT" : "PLUGIN_ROOT",
    };
    const walk = (rel: string) => {
      for (const f of readdirSync(join(root, "clients/shared", rel), { withFileTypes: true })) {
        const name = join(rel, f.name);
        if (f.isDirectory()) walk(name);
        else {
          let body = readFileSync(join(root, "clients/shared", name), "utf8");
          body = body.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => { if (!(k in vars)) throw new Error(`unknown template variable ${k}`); return vars[k]!; });
          outputs.set(join(target, name), body);
        }
      }
    };
    walk("");
    outputs.set(`${target}/.mcp.json`, JSON.stringify({ mcpServers: { bigbrain: {
      command: "sh",
      // Codex resolves cwd relative to the plugin; it does not expand hook
      // variables in MCP args. Claude expands CLAUDE_PLUGIN_ROOT itself.
      ...(agent === "codex" ? { args: ["scripts/local.sh", "--connection", "codex-plugin"], cwd: "." } : { args: [`${hookRoot}/scripts/local.sh`, "--connection", "claude-plugin"] }),
    } } }, null, 2) + "\n");
    if (agent === "claude") {
      for (const name of ["hooks.json"]) outputs.set(`${target}/hooks/${name}`, readFileSync(join(root, "clients/adapters/claude", name), "utf8"));
      const manifest = JSON.parse(readFileSync(join(root, "clients/adapters/claude/plugin.json"), "utf8"));
      outputs.set(`${target}/.claude-plugin/plugin.json`, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
    } else {
      outputs.set(`${target}/.codex-plugin/plugin.json`, JSON.stringify({ name: "bigbrain", version, description: "Search, contribute to, and remember your BigBrain vault from Codex.", skills: "./skills/", mcpServers: "./.mcp.json", author: { name: "BigBrain" }, homepage: "https://bigbrain.cool", interface: { displayName: "BigBrain", shortDescription: "Your vault in Codex", longDescription: "Search your BigBrain vault, contribute notes, and load your curated memory. Optional hooks preload memory.", developerName: "BigBrain", category: "Productivity", capabilities: ["Read", "Write"], defaultPrompt: "Search my BigBrain vault for context relevant to this task." } }, null, 2) + "\n");
      outputs.set(`${target}/hooks/hooks.json`, JSON.stringify({ hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `sh "${hookRoot}/hooks/session-start.sh"`, timeout: 15 }] }],
      } }, null, 2) + "\n");
      outputs.set("clients/codex-plugin/.agents/plugins/marketplace.json", JSON.stringify({ name: "bigbrain", interface: { displayName: "BigBrain" }, plugins: [{ name: "bigbrain", source: { source: "local", path: "./plugins/bigbrain" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2) + "\n");
    }
  }
  const stale: string[] = [];
  const removeOrphans = (rel: string) => {
    if (!existsSync(join(root, rel))) return;
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const name = join(rel, entry.name);
      if (entry.isDirectory()) removeOrphans(name);
      else if (!outputs.has(name)) { if (check) stale.push(name); else rmSync(join(root, name)); }
    }
  };
  // Only these generated trees belong to the renderer; other client files
  // (the Claude marketplace and README, for example) are maintained directly.
  for (const rel of ["clients/claude-plugin/skills", "clients/claude-plugin/scripts", "clients/claude-plugin/hooks", "clients/codex-plugin/plugins", "clients/codex-plugin/.agents"]) removeOrphans(rel);
  for (const [rel, body] of outputs) {
    const path = join(root, rel);
    if (existsSync(path) && readFileSync(path, "utf8") === body) continue;
    if (check) stale.push(rel);
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); }
  }
  if (stale.length) throw new Error(`Generated agent plugins are stale. Run bun run plugins:build:\n${stale.join("\n")}`);
}
if (import.meta.main) buildAgentPlugins(ENGINE_ROOT, process.argv.includes("--check"));
