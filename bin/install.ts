/**
 * install.ts — make this machine's vault and command match this engine.
 *
 * It used to render and load the machine's launchd/systemd jobs; the CLI
 * host install retired on 2026-08-31 (#645) and the desktop app supervises
 * its own children, so what is left is the half that was always doing the
 * quieter work:
 *
 *   - the storage planes and the generated vault files (CLAUDE.md, the
 *     skills, .gitignore, the prompts) refreshed to this engine, and the
 *     drift committed;
 *   - the write guard re-rendered, if the user ever consented to one;
 *   - `~/.local/bin/bigbrain` pointed at this checkout — unless the desktop
 *     app owns the command, which it does on any machine running the app;
 *   - the machine's default-vault pointer, when it has none.
 *
 * Run it after `git pull`. Idempotent, and safe to run twice.
 *
 * Usage: bun bin/install.ts
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadManifest } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { ENGINE_ROOT, vaultPointer } from "../lib/engine";
import { bigbrainCommandPath, engineBehindCommand, isAppShim } from "../lib/bigbrainCommand";
import { ensureDir, writeAtomic } from "../lib/fsx";
import { runPreflight } from "../lib/preflight";
import { ensureStoragePlanes, scaffoldVault, shedVaultPrompts } from "../lib/scaffold";
import { refreshHook } from "../lib/hook";
import { commitAs } from "../lib/git";

const root = VAULT_ROOT;

// .state/logs must exist before anything writes there.
ensureDir(join(root, ".state", "logs"), 0o700);

// references tree + .blobs/ — the storage planes.
const planesChanged = ensureStoragePlanes(root);

const manifest = loadManifest(root); // validates vault.yaml before anything else

// Warn-only preflight: a machine whose passes can't find claude should hear
// about it now rather than at the next run. bin/init.ts runs the full
// blocking set.
for (const c of runPreflight({ auth: manifest.auth, agent: manifest.gardener.adapter as "claude" | "pi", provider: manifest.gardener.provider, root })) {
  if (!c.ok) console.error(`install: warning — ${c.detail}${c.fix ? `: ${c.fix}` : ""}`);
}

// The write guard tracks the engine: refresh an entry the user already
// consented to (via `bigbrain hook --apply` at setup) so guard fixes ship
// with engine updates. Never adds one — first install stays explicit.
const hookState = refreshHook(root);
if (hookState === "refreshed")
  console.log("install: write guard refreshed to the current rendering");
else if (hookState === "absent")
  console.log(
    "install: note — no write guard installed for this checkout (`bigbrain hook` previews it)"
  );
else if (hookState === "unparseable")
  console.error(
    "install: warning — ~/.claude/settings.json is not valid JSON; write guard left untouched"
  );

// The `bigbrain` command: a stable name on PATH for a per-machine engine
// location. Replace a wrong target; never touch a non-symlink — in
// particular not the desktop app's shim: on a machine running the app,
// the app owns the command and rewrites it at every launch to run its
// own engine (lib/bigbrainCommand.ts).
const link = bigbrainCommandPath();
const target = join(ENGINE_ROOT, "bin", "cli.ts");
ensureDir(join(homedir(), ".local", "bin"));
const st = lstatSync(link, { throwIfNoEntry: false });
if (st && !st.isSymbolicLink()) {
  if (isAppShim(link)) {
    const runs = engineBehindCommand(link);
    console.log(
      runs === ENGINE_ROOT
        ? "install: bigbrain is BigBrain.app's shim and already runs this engine — left as is"
        : `install: note — bigbrain is BigBrain.app's shim and runs ${runs ?? "the app's engine"}, not this checkout; the app owns the command on this machine, so it is left alone`
    );
  } else {
    console.error(
      `install: warning — ${link} exists and is not a symlink; leaving it (bigbrain may resolve elsewhere)`
    );
  }
} else {
  if (st && readlinkSync(link) !== target) unlinkSync(link);
  if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(target, link);
  console.log(`install: bigbrain → ${target}`);
}

// Machine default-vault pointer: only when absent — a machine can hold
// several vaults and the pointer must not flap with each install. Env
// and cwd discovery always win.
if (!existsSync(vaultPointer())) {
  writeAtomic(vaultPointer(), root + "\n", 0o600);
  console.log(`install: default vault pointer → ${root}`);
}

// The generated vault files track the engine — refresh them and commit
// the drift. Prompt copies from before #524 are shed in the same pass:
// they overrode the engine's text and nothing ever updated them.
const shed = shedVaultPrompts(root);
if (shed.length)
  console.log(
    `install: shed ${shed.length} vault prompt copy(ies) — ${shed.join(", ")} — ` +
      "the engine's prompts are the prompts now (recover one with `git show HEAD~1:<path>`)"
  );
const changed = [...planesChanged, ...shed, ...scaffoldVault(root)];
if (changed.length) {
  const committed = commitAs(
    root,
    "init",
    `install: scaffold refreshed (${changed.join(", ")})`,
    changed
  );
  console.log(
    `install: scaffold refreshed — ${changed.join(", ")}${committed ? " (committed)" : ""}`
  );
}
if (!existsSync(join(ENGINE_ROOT, "web", "ui", "dist", "index.html")))
  console.error(
    `install: warning — web UI not built; run \`bun run web:build\` in ${ENGINE_ROOT}`
  );

console.log(`install: this checkout is installed (vault ${root}, engine ${ENGINE_ROOT})`);
