/**
 * scaffold.ts — the generated part of a vault: CLAUDE.md, .claude/
 * (settings + skills), .gitignore, and the prompt seeds. The engine is the
 * single source of truth; init writes these into a fresh vault and
 * `bigbrain install` refreshes them after engine updates. Skills MERGE (a
 * vault may carry its own local skills, which are never deleted) and the
 * engine ships only what SHIPPED_SKILLS names; template files are
 * overwritten — user overrides belong in .claude/settings.local.json and
 * the notes themselves.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./engine";
import { ensureDir, writeAtomic } from "./fsx";
import { REFERENCES_DIR } from "./references";

const TEMPLATE_DIR = join(ENGINE_ROOT, "deploy", "vault-template");

/** Copy `from` to `<root>/<rel>` when the content differs; report `rel`. */
function sync(root: string, from: string, rel: string, changed: string[]): void {
  const content = readFileSync(from, "utf8");
  const dest = join(root, rel);
  if (existsSync(dest) && readFileSync(dest, "utf8") === content) return;
  writeAtomic(dest, content);
  changed.push(rel);
}

/**
 * Skills this engine once scaffolded and now RETRACTS (#45 decision 8; Nick,
 * 2026-08-10: *"plan to deprecate the skills we have locally here, they'll
 * only confuse us"*).
 *
 * Both described the pre-lake-refactor vault — `domains/`, `library/`,
 * `inbox/`, and a `triage` pass that routed by matching domain descriptions in
 * vault.yaml. None of that exists, so they misdirect every agent that opens
 * them. Their replacement is the Claude Code plugin's HTTP pair
 * (`clients/claude-plugin/skills/`), which carries the same two names and
 * works from any directory, on any machine, checkout or not.
 *
 * **Deleted, not merely un-copied.** They are already on disk in every vault
 * provisioned so far, and a skill nothing writes any more is still a skill
 * agents read. This is the one exception to "skills MERGE": these are not a
 * vault's own local skills, they are this engine's, and retracting what we
 * shipped is ours to do.
 */
const RETIRED_SKILLS = ["vault-search", "vault-add", "setup", "verify"] as const;

/**
 * Skills this engine ships INTO a vault. Explicit, because the engine's own
 * `.claude/skills/` is where this checkout's development skills live and a
 * vault is not a development checkout: copying the directory wholesale is
 * how `verify` — "run `bun install`, build the viewer against a sandbox
 * vault" — ended up in every user's record.
 *
 * Empty today. `setup` retired with the app's first-run wizard (#575), which
 * asks the same questions in the app and calls the same `bigbrain init`
 * backend; the copy in this checkout stays, for a person setting a vault up
 * from a terminal.
 */
const SHIPPED_SKILLS: readonly string[] = [];

/** Prompt copies a vault carried before #524, shed on install.
 *
 * Seeding stopped in #524 and a fresh vault gets no `prompts/` at all — a
 * prompt is the engine's text, versioned with the engine. But a vault made
 * before that still HOLDS its copies, and the readers preferred the vault's,
 * so those copies won forever: a pre-retirement installation could be
 * running a `memory.md` frozen at 2026-08-28 plus `editor.md`, `import.md`
 * and `discuss.md` for passes that had been retired for weeks. Every engine
 * prompt fix since had reached exactly nobody.
 *
 * Nothing was ever edited — every copy in the wild is byte-identical to some
 * engine commit — so shedding them is not discarding anyone's work, and the
 * vault is a git repo either way: `git show HEAD~1:prompts/memory.md` brings
 * one back. Returns what it removed. */
export function shedVaultPrompts(root: string): string[] {
  const dir = join(root, "prompts");
  if (!existsSync(dir)) return [];
  const shed: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") && f !== "VERSION") continue;
    rmSync(join(dir, f), { force: true });
    shed.push(`prompts/${f}`);
  }
  if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  return shed.sort();
}

/** Write/refresh the generated vault files. Returns the vault-relative
 * paths that actually changed (empty = already current). */
export function scaffoldVault(root: string): string[] {
  const changed: string[] = [];
  sync(root, join(TEMPLATE_DIR, "CLAUDE.md"), "CLAUDE.md", changed);
  sync(root, join(TEMPLATE_DIR, "README.md"), "README.md", changed);
  sync(root, join(TEMPLATE_DIR, "settings.json"), ".claude/settings.json", changed);
  sync(root, join(TEMPLATE_DIR, "gitignore"), ".gitignore", changed);

  for (const skill of SHIPPED_SKILLS) {
    const dir = join(ENGINE_ROOT, ".claude", "skills", skill);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      sync(root, join(dir, f), `.claude/skills/${skill}/${f}`, changed);
    }
  }

  for (const skill of RETIRED_SKILLS) {
    const dir = join(root, ".claude", "skills", skill);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) changed.push(`.claude/skills/${skill}/${f}`);
    rmSync(dir, { recursive: true, force: true });
  }
  return changed;
}

/** Ensure the two storage planes exist: the references tree (committed —
 * needs a .gitkeep until its first landing survives git) and `.blobs/`
 * (gitignored CAS root, created empty so the first `putBlob` isn't the
 * sole thing that conjures it). Called by init (fresh vault) and install.
 * Idempotent, safe to call every run. Returns the vault-relative paths
 * that were newly created. */
export function ensureStoragePlanes(root: string): string[] {
  const changed: string[] = [];
  const refsDir = join(root, REFERENCES_DIR);
  if (!existsSync(refsDir) || !readdirSync(refsDir).length) {
    writeAtomic(join(refsDir, ".gitkeep"), "");
    changed.push(`${REFERENCES_DIR}/.gitkeep`);
  }
  ensureDir(join(root, ".blobs"));
  return changed;
}
