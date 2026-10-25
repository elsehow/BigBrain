#!/usr/bin/env bun
/**
 * cli.ts — `bigbrain`, the one command. The engine lives wherever this
 * checkout is; a vault lives wherever it lives; this wrapper joins them:
 * it resolves the vault (env → walk-up-from-cwd → pointer), then runs the
 * requested engine script with BIGBRAIN_VAULT set and cwd = the vault — the
 * same shape the supervisor's children get, so a manual `bigbrain tend` and the
 * 3am run are the same run (bun autoloads .env from cwd).
 *
 * install.ts symlinks this to ~/.local/bin/bigbrain, so skills, docs, and
 * hook messages can say `bigbrain <cmd>` on every machine regardless of
 * where the engine checkout sits.
 *
 * The surface is tiered (#60): a handful of verbs are the product, a few
 * more are setup, and the rest is plumbing that the supervisor and doors
 * invoke — routable forever, listed never. Help shows the first two tiers.
 */

import { join, resolve } from "node:path";
import { discoverVaultRoot, ENGINE_ROOT, vaultPointer } from "../lib/engine";

/** The product — what a person or agent types day to day. */
const EVERYDAY: Record<string, [script: string, blurb: string]> = {
  search: ["bin/search.ts", "ranked full-text over every note"],
  assertions: ["bin/assertions.ts", "a date-ordered window over the record; --entities for the map"],
  drop: ["bin/drop.ts", "put an item into the vault"],
  firewall: ["bin/firewall.ts", "screen arrivals for credentials and reset links: status, install, off"],
  observe: ["bin/observe.ts", "submit evidence to the memory pass"],
  tend: ["bin/tend.ts", "run the gardener: drain due intake + memory with your Claude"],
  feed: ["bin/feed.ts", "what needs you, what an agent could do, what's worth knowing (vault.yaml feed:)"],
  agent: ["bin/agent.ts", "run an agent on your projects in its own desktop folder (run, resume, list, land, discard)"],
  links: ["bin/links.ts", "wikilink lint and conversion"],
  blob: ["bin/blob.ts", "follow a blob: link to bytes"],
};

/** Setup and ops — humans, rarely. */
const SETUP: Record<string, [script: string, blurb: string]> = {
  init: ["bin/init.ts", "create a vault (backend for /setup)"],
  install: ["bin/install.ts", "link the bigbrain command; refresh the vault's scaffold"],
  auth: ["bin/auth.ts", "credentials: create/list/revoke drop tokens"],
  connect: ["bin/connect.ts", "wire this machine's Claude Code to the vault: mint + save its token, install the plugin"],
  publish: ["bin/publish.ts", "push the vault to its origin remote"],
  mcp: ["bin/mcp.ts", "local memory access for agents (mcp config: print configuration; mcp register: install it)"],
  entity: ["bin/entity.ts", "entity identity: alias <label> --into <id|label>, resolve, aliases, supersede, folds"],
  whoami: ["bin/whoami.ts", "who this vault is about; --declare \"<name>\" to say, --adopt-dossier to fold a hosted-era dossier in"],
  shared: ["bin/shared.ts", "a SHARED vault, named by --vault: init, members, credentials, serve (docs/shared-vault.md)"],
};

/** Plumbing — the supervisor, doors, and passes invoke these; people don't.
 * Routable but unlisted. `hook` stays here on purpose: installing the
 * write guard mutates ~/.claude/settings.json, so first install remains
 * an explicit consented step (the /setup flow); `bigbrain install`
 * refreshes an entry that's already there. */
const PLUMBING: Record<string, string> = {
  memory: "bin/memory.ts",
  api: "bin/api.ts",
  web: "web/server.ts",
  hook: "bin/hook.ts",
  retrieval: "bin/retrieval.ts",
  use: "bin/use.ts",
  econ: "bin/econ.ts",
};

function resolveCmd(name: string): { script: string; prepend: string[] } | undefined {
  if (EVERYDAY[name]) return { script: EVERYDAY[name][0], prepend: [] };
  if (SETUP[name]) return { script: SETUP[name][0], prepend: [] };
  if (PLUMBING[name]) return { script: PLUMBING[name], prepend: [] };
  return undefined;
}

function usage(): void {
  const width = Math.max(...[...Object.keys(EVERYDAY), ...Object.keys(SETUP)].map((k) => k.length));
  console.error(`bigbrain — a markdown vault a machine keeps organized (engine: ${ENGINE_ROOT})`);
  console.error(`usage: bigbrain <command> [args]`);
  console.error("");
  for (const [k, [, blurb]] of Object.entries(EVERYDAY))
    console.error(`  ${k.padEnd(width)}  ${blurb}`);
  console.error("");
  console.error("setup:");
  for (const [k, [, blurb]] of Object.entries(SETUP))
    console.error(`  ${k.padEnd(width)}  ${blurb}`);
  console.error("");
  console.error(
    `the vault is found via BIGBRAIN_VAULT, the nearest vault.yaml above cwd, or ${vaultPointer()}`
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const resolved = cmd ? resolveCmd(cmd) : undefined;
if (!cmd || !resolved) {
  usage();
  process.exit(cmd ? 2 : 0);
}

const env: Record<string, string | undefined> = { ...process.env };
let cwd = process.cwd();

if (cmd === "shared") {
  // The shared vault is named by its own --vault flag (bin/shared.ts) and
  // is never discovered: this machine's personal vault must not end up
  // served to other people because someone ran the command from inside it.
} else if (cmd === "init") {
  // init may target a directory that is not a vault yet: --vault > env > cwd.
  const i = rest.indexOf("--vault");
  if (i !== -1 && rest[i + 1]) env["BIGBRAIN_VAULT"] = resolve(rest[i + 1]!);
  else env["BIGBRAIN_VAULT"] ??= process.cwd();
} else {
  const vault = discoverVaultRoot();
  if (!vault) {
    console.error(
      `bigbrain: no vault found — set BIGBRAIN_VAULT, run from inside a vault, or create ${vaultPointer()}.`
    );
    console.error(`No vault yet? bigbrain init --vault <path>`);
    process.exit(2);
  }
  env["BIGBRAIN_VAULT"] = vault;
  cwd = vault; // .env autoload + content-relative behavior, same as the supervisor
}

const r = Bun.spawnSync(
  [process.execPath, join(ENGINE_ROOT, resolved.script), ...resolved.prepend, ...rest],
  {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }
);
process.exit(r.exitCode ?? 1);
