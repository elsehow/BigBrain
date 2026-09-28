/**
 * pluginState.ts — the `bigbrain` plugin as Claude Code holds it, against
 * the one this engine ships (clients/claude-plugin), and the refresh that
 * closes the gap.
 *
 * Claude Code COPIES a plugin into its cache at install
 * (`<config>/plugins/cache/bigbrain/bigbrain/<version>/`), keyed by
 * plugin.json's version, and `claude plugin update` is a no-op while that
 * version matches the marketplace's — content changes under the same
 * version are invisible to it (verified 2026-08-28 in a sandboxed
 * CLAUDE_CONFIG_DIR). So: every change to the plugin bumps its version
 * (test/pluginVersion.test.ts enforces it), and "installed" here means
 * "the shipped version, from THIS engine's directory" — a marketplace still
 * pointed at an old checkout or an old app path is stale too.
 *
 * Two readers: the desktop supervisor refreshes at launch when the state
 * is stale (an app update carries its plugin with it), and the agents card
 * shows both versions so drift is visible (lib/firstRun.ts claudeStatus).
 * `connect` always runs the full install-and-refresh (lib/connect.ts).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pluginRefreshCommands } from "./connect";
import { ENGINE_ROOT } from "./engine";
import { jobsPath } from "./preflight";

const PLUGIN_ID = "bigbrain@bigbrain";

/** Where Claude Code keeps its state: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(home: string = homedir()): string {
  const env = process.env["CLAUDE_CONFIG_DIR"]?.trim();
  return env ? resolve(env) : join(home, ".claude");
}

/** This engine's copy of the plugin — the marketplace directory. */
const pluginDir = (engineRoot: string = ENGINE_ROOT): string => join(engineRoot, "clients", "claude-plugin");

/** The version this engine ships, from plugin.json. */
export function shippedPluginVersion(engineRoot: string = ENGINE_ROOT): string {
  const v = (JSON.parse(readFileSync(join(pluginDir(engineRoot), ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v)) throw new Error(`plugin.json version is not a version: ${String(v)}`);
  return v;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The installed plugin's version (user scope first), or null. */
export function installedPluginVersion(configDir: string = claudeConfigDir()): string | null {
  const data = readJson(join(configDir, "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, Array<{ scope?: string; version?: string }>>;
  } | null;
  const entries = data?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(entries) || !entries.length) return null;
  const pick = entries.find((e) => e.scope === "user") ?? entries[0]!;
  return typeof pick.version === "string" ? pick.version : null;
}

/** Where the `bigbrain` marketplace points, or null when none is known. */
export function pluginMarketplacePath(configDir: string = claudeConfigDir()): string | null {
  const data = readJson(join(configDir, "plugins", "known_marketplaces.json")) as Record<
    string,
    { source?: { source?: string; path?: string } }
  > | null;
  const p = data?.["bigbrain"]?.source?.path;
  return typeof p === "string" && p ? resolve(p) : null;
}

export interface PluginStatus {
  /** The version this engine ships. */
  shipped: string;
  /** What Claude Code has installed — null when nothing. */
  installed: string | null;
  /** Where its marketplace points — null when none. */
  marketplace: string | null;
  /** Installed at the shipped version, from this engine's directory. */
  current: boolean;
}

export function pluginStatus(engineRoot: string = ENGINE_ROOT, configDir: string = claudeConfigDir()): PluginStatus {
  const shipped = shippedPluginVersion(engineRoot);
  const installed = installedPluginVersion(configDir);
  const marketplace = pluginMarketplacePath(configDir);
  const here = resolve(pluginDir(engineRoot));
  const current = installed === shipped && marketplace !== null && sameDir(marketplace, here);
  return { shipped, installed, marketplace, current };
}

/** Same directory, through symlinks where both exist (/private/tmp vs /tmp
 * on macOS, a bundle reached two ways). */
function sameDir(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

export type PluginRefresh =
  | { outcome: "absent" | "current" | "refreshed"; status: PluginStatus }
  | { outcome: "failed"; status: PluginStatus; command: string; output: string };

function runQuiet(argv: string[], path: string): Promise<{ status: number | null; output: string; error?: Error }> {
  return new Promise((done) => {
    let output = "";
    const child = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: path }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (error) => done({ status: null, output, error }));
    child.on("exit", (status) => done({ status, output: output.trim() }));
  });
}

/** Bring an installed plugin up to this engine: re-point the marketplace
 * here and update. Nothing when none is installed (that is connect's job)
 * or when it is already current. Never throws — the outcome says. */
export async function refreshPlugin(
  engineRoot: string = ENGINE_ROOT,
  opts: { configDir?: string; path?: string } = {}
): Promise<PluginRefresh> {
  const configDir = opts.configDir ?? claudeConfigDir();
  const status = pluginStatus(engineRoot, configDir);
  if (status.installed === null) return { outcome: "absent", status };
  if (status.current) return { outcome: "current", status };
  for (const argv of pluginRefreshCommands(engineRoot)) {
    const r = await runQuiet(argv, opts.path ?? jobsPath());
    if (r.error || r.status !== 0) {
      return {
        outcome: "failed",
        status,
        command: argv.slice(0, 4).join(" "),
        output: (r.error ? r.error.message : r.output).slice(0, 300),
      };
    }
  }
  return { outcome: "refreshed", status: pluginStatus(engineRoot, configDir) };
}

/** Why this engine must not own the machine's plugin, or null when it may.
 * A worktree under `.claude/worktrees/` lives as long as its branch; a
 * marketplace registered from one dies with it, and every `/bigbrain:*`
 * command goes unknown in every session on the machine (#677). The
 * supervisor already skips its launch refresh in the dev loop
 * (bin/desktop.ts, `BIGBRAIN_DEV`); this is the same rule for the two
 * connect doors, keyed on the path, which is what a `/verify` run has. */
export function worktreeEngine(engineRoot: string): string | null {
  const parts = resolve(engineRoot).split(sep);
  const i = parts.indexOf(".claude");
  if (i === -1 || parts[i + 1] !== "worktrees") return null;
  return `${engineRoot} is a worktree — it dies with its branch, and a plugin marketplace registered from it would too (#677); run from the main checkout or the app`;
}

/** True when the plugin directory exists — a bundle or checkout that
 * carries the plugin; a tree without it has nothing to refresh from. */
export const hasPluginDir = (engineRoot: string = ENGINE_ROOT): boolean => existsSync(join(pluginDir(engineRoot), ".claude-plugin", "plugin.json"));
