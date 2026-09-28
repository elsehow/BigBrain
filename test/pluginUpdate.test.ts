/**
 * The UPDATE button's gate (ClaudeConnect.svelte). Claude Code caches a
 * plugin by version, so a person can SEE the drift on the agents card and
 * have no way to close it but quit the app — that button is the way, and
 * this is the one rule that decides whether it is there.
 */
import { describe, expect, test } from "bun:test";
import { pluginUpdatable, type PluginStatus, type SetupState } from "../web/ui/src/lib/setup";

const HERE = "/Applications/BigBrain.app/Contents/Resources/resources/engine/clients/claude-plugin";
const CURRENT: PluginStatus = { shipped: "0.1.6", installed: "0.1.6", marketplace: HERE, current: true };

const state = (plugin: PluginStatus | null | undefined, opts: { revoked?: string | null } = {}): SetupState => ({
  vault: { path: "/Users/x/vault", created: "2026-08-01T00:00:00Z" },
  claude: { installed: "2.1.247", account: "x@example.com", plugin },
  agent: { name: "claude code on mac", connected: "2026-08-01T00:00:00Z", lastUsed: null, revoked: opts.revoked ?? null },
});

describe("the plugin UPDATE gate", () => {
  test("behind the engine, connected: offered", () => {
    expect(pluginUpdatable(state({ ...CURRENT, installed: "0.1.5", current: false }))).toBe(true);
  });

  test("the right version from another tree is behind too", () => {
    // an old checkout's marketplace: same version string, wrong plugin
    expect(pluginUpdatable(state({ ...CURRENT, marketplace: "/Users/x/Projects/BigBrain/clients/claude-plugin", current: false }))).toBe(true);
  });

  test("current: nothing to offer", () => {
    expect(pluginUpdatable(state(CURRENT))).toBe(false);
  });

  test("nothing installed: CONNECT installs it, UPDATE does not", () => {
    expect(pluginUpdatable(state({ ...CURRENT, installed: null, marketplace: null, current: false }))).toBe(false);
  });

  test("no Claude Code connected: CONNECT is on screen and refreshes as it goes", () => {
    expect(pluginUpdatable(state({ ...CURRENT, installed: "0.1.5", current: false }, { revoked: "2026-08-20T00:00:00Z" }))).toBe(false);
  });

  test("an engine too old to report the plugin offers nothing", () => {
    expect(pluginUpdatable(state(undefined))).toBe(false);
    expect(pluginUpdatable(state(null))).toBe(false);
  });
});
