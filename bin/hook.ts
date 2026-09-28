/**
 * hook.ts — install the interactive-session write guard for THIS checkout
 * into the user-global ~/.claude/settings.json (semantics in lib/hook.ts;
 * background in deploy/HOOK.md).
 *
 * Mutating a person's global Claude settings silently is not okay, so the
 * default is a dry run: print the rendered entry, show whether/what it
 * would change, and hand over the --apply command. --apply backs up the
 * old file first. --remove strips exactly this checkout's entry.
 *
 * Usage: bun bin/hook.ts [--apply | --remove]
 */

import { VAULT_ROOT } from "../lib/vaultRoot";
import {
  hookInstalled,
  mergeHook,
  readSettings,
  removeHookFrom,
  renderHookEntry,
  settingsPath,
  writeSettingsWithBackup,
} from "../lib/hook";

const root = VAULT_ROOT;
const path = settingsPath();

let settings: ReturnType<typeof readSettings>;
try {
  settings = readSettings();
} catch (e) {
  console.error(
    `hook: ${path} exists but is not valid JSON — fix it by hand first (${e instanceof Error ? e.message : e})`
  );
  process.exit(1);
}

function write(next: object): void {
  const r = writeSettingsWithBackup(next);
  if (r.backup) console.error(`hook: backed up ${r.path} → ${r.backup}`);
  console.error(`hook: wrote ${r.path} (re-serialized with 2-space indent)`);
}

if (process.argv.includes("--remove")) {
  const r = removeHookFrom(settings, root);
  if (!r.changed) {
    console.log(`hook: no entry for ${root} in ${path} — nothing to remove`);
    process.exit(0);
  }
  write(r.settings);
  console.log(`hook: removed the write guard for ${root}`);
  process.exit(0);
}

if (process.argv.includes("--apply")) {
  const r = mergeHook(settings, root);
  if (!r.changed) {
    console.log(`hook: the write guard for ${root} is already installed`);
    process.exit(0);
  }
  write(r.settings);
  console.log(
    `hook: installed the write guard for ${root} — new interactive sessions are read-only on vault content`
  );
  process.exit(0);
}

// default: dry run
console.log(`The write guard for ${root}:`);
console.log(JSON.stringify(renderHookEntry(root), null, 2));
console.log("");
if (hookInstalled(root)) {
  const same = !mergeHook(settings, root).changed;
  console.log(
    same
      ? `Already installed in ${path} — nothing to do.`
      : `An older entry for this checkout exists in ${path} — run \`bun bin/hook.ts --apply\` to update it.`
  );
} else {
  console.log(`Not installed. Run \`bun bin/hook.ts --apply\` to merge it into ${path}`);
  console.log(`(your other settings are untouched; the old file is backed up first).`);
}
