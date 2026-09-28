import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfigDir,
  installedPluginVersion,
  pluginMarketplacePath,
  pluginStatus,
  refreshPlugin,
  shippedPluginVersion,
  worktreeEngine,
} from "../lib/pluginState";

const ENGINE = join(import.meta.dir, "..");
const HERE = join(ENGINE, "clients", "claude-plugin");

/** A Claude Code config dir holding the two files the status reads. */
function configDir(installed: string | null, marketplace: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-claude-cfg-"));
  mkdirSync(join(dir, "plugins"), { recursive: true });
  if (installed !== null)
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "bigbrain@bigbrain": [{ scope: "user", version: installed, installPath: "/x" }] } })
    );
  if (marketplace !== null)
    writeFileSync(
      join(dir, "plugins", "known_marketplaces.json"),
      JSON.stringify({ bigbrain: { source: { source: "directory", path: marketplace } } })
    );
  return dir;
}

describe("plugin state", () => {
  const shipped = shippedPluginVersion(ENGINE);

  test("the shipped version is plugin.json's", () => {
    expect(shipped).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("config dir: $CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    const was = process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["CLAUDE_CONFIG_DIR"];
    expect(claudeConfigDir("/home/x")).toBe("/home/x/.claude");
    process.env["CLAUDE_CONFIG_DIR"] = "/elsewhere/cfg";
    expect(claudeConfigDir("/home/x")).toBe("/elsewhere/cfg");
    if (was === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = was;
  });

  test("nothing installed, no marketplace", () => {
    const dir = configDir(null, null);
    expect(installedPluginVersion(dir)).toBeNull();
    expect(pluginMarketplacePath(dir)).toBeNull();
    expect(pluginStatus(ENGINE, dir)).toEqual({ shipped, installed: null, marketplace: null, current: false });
  });

  test("current: the shipped version from this engine's directory", () => {
    const dir = configDir(shipped, HERE);
    expect(pluginStatus(ENGINE, dir).current).toBe(true);
  });

  test("stale: an older version, or the right version from another tree", () => {
    expect(pluginStatus(ENGINE, configDir("0.0.1", HERE)).current).toBe(false);
    expect(pluginStatus(ENGINE, configDir(shipped, "/old/checkout/clients/claude-plugin")).current).toBe(false);
  });

  test("refresh: absent and current run nothing; stale runs the commands and reports a failure honestly", async () => {
    expect((await refreshPlugin(ENGINE, { configDir: configDir(null, null), path: "/nonexistent" })).outcome).toBe("absent");
    expect((await refreshPlugin(ENGINE, { configDir: configDir(shipped, HERE), path: "/nonexistent" })).outcome).toBe("current");
    // stale, with no `claude` on the PATH given: the first command fails and says which
    const r = await refreshPlugin(ENGINE, { configDir: configDir("0.0.1", HERE), path: "/nonexistent" });
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.command).toBe("claude plugin marketplace add");
      expect(r.output).toMatch(/ENOENT|not found/i);
    }
  });
});

describe("worktreeEngine (#677)", () => {
  test("a tree under .claude/worktrees/ may not own the machine's plugin; a checkout or a bundle may", () => {
    expect(worktreeEngine("/Users/n/Projects/BigBrain/.claude/worktrees/retire-host-install")).toContain("worktree");
    expect(worktreeEngine("/Users/n/Projects/BigBrain/.claude/worktrees/x/")).toContain("#677");
    expect(worktreeEngine("/Users/n/Projects/BigBrain")).toBeNull();
    expect(worktreeEngine("/Applications/BigBrain.app/Contents/Resources/resources/engine")).toBeNull();
    expect(worktreeEngine("/Users/n/.claude/plugins/cache/x")).toBeNull();
  });
});
