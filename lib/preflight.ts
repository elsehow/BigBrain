/**
 * preflight.ts — can this machine actually run the vault? One source of
 * truth for the environment checks: bin/init.ts runs the full set and
 * blocks on failures; bin/install.ts runs a warn-only subset so it stays
 * usable as a bare job re-compiler. Every check is cheap (local configuration,
 * short timeout) and its `fix` copy is written for a first-timer.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
// This module must work with NO vault (bin/desktop.ts opens the first-run
// door before one exists), so the root is asked for lazily, below.
import type { Auth } from "./manifest";
import { ENGINE_ROOT, requireVaultRoot } from "./engine";
import { readEnvValues } from "./envFile";
import { bigbrainCommandPath, engineBehindCommand } from "./bigbrainCommand";

export interface Check {
  name: string;
  ok: boolean;
  /** `fail` blocks init; `warn` is surfaced and worked around. */
  level: "fail" | "warn";
  detail: string;
  fix?: string;
}

/** The PATH the supervisor's children get (bin/desktop.ts) — one
 * definition, for engine and optional external-client commands. ~/.local/bin and the bun dir lead;
 * on macOS /opt/homebrew/bin follows because brew is where most people's
 * tools live. */
export function jobsPath(): string {
  const system =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : ["/usr/local/bin", "/usr/bin", "/bin"];
  return [join(homedir(), ".local", "bin"), dirname(process.execPath), ...system].join(":");
}

function runs(cmd: string, args: string[], env?: Record<string, string | undefined>): boolean {
  const r = spawnSync(cmd, args, {
    timeout: 10_000,
    stdio: "ignore",
    env: env ? { ...process.env, ...env } : undefined,
  });
  return r.status === 0;
}

function envHasKey(root: string, key: string): boolean {
  // The one .env parser (lib/envFile.ts) — not a third hand-rolled regex (#635).
  return Boolean(readEnvValues(root)[key]);
}

/** Under `auth: api`: is the key where the gardener will look — the vault's
 * .env, read on demand. Engine processes no longer inherit it (lib/env.ts
 * NO_ENV_FILE), so a key only in some environment is not one it can use. */
export function apiKeyPresent(root: string): boolean {
  return envHasKey(root, "ANTHROPIC_API_KEY");
}

export interface PreflightOpts {
  agent?: "claude" | "codex" | "pi";
  provider?: string;
  auth?: Auth;
  root?: string;
}

export function runPreflight(opts: PreflightOpts = {}): Check[] {
  const root = opts.root ?? requireVaultRoot();
  const checks: Check[] = [];

  checks.push({
    name: "git",
    ok: runs("git", ["--version"]),
    level: "fail",
    detail: "git on PATH",
    fix: "install the Xcode Command Line Tools: xcode-select --install",
  });

  checks.push({
    name: "jq",
    ok: runs("jq", ["--version"], { PATH: jobsPath() }),
    level: "warn",
    detail: "jq available",
    fix: "the interactive-session write guard (bun bin/hook.ts) needs it: `brew install jq` (macOS) / `apt install jq` (Linux)",
  });

  const values = readEnvValues(root);
  const provider = opts.provider ?? "anthropic";
  const connected = provider === "anthropic" ? values.BIGBRAIN_ANTHROPIC_CONNECTED === "1"
    : provider === "openai-codex" ? values.BIGBRAIN_CHATGPT_CONNECTED === "1"
    : provider === "openai" && envHasKey(root, "OPENAI_API_KEY");
  checks.push({ name: "model-connection", ok: connected, level: "warn",
    detail: `${provider} model connection ${connected ? "configured" : "not connected"}`,
    fix: "connect your provider in Settings > Models; model work waits until connected" });

  // The `bigbrain` name must mean THIS engine, or skills and docs lie.
  // Either form counts: install's symlink, or the desktop app's shim
  // naming this engine (lib/bigbrainCommand.ts).
  checks.push({
    name: "bigbrain-symlink",
    ok: engineBehindCommand(bigbrainCommandPath()) === ENGINE_ROOT,
    level: "warn",
    detail: "~/.local/bin/bigbrain runs this engine",
    fix: "run `bun bin/install.ts` from this engine — it maintains the symlink (on a machine running BigBrain.app, the app owns the command and runs its own engine)",
  });

  return checks;
}
