/**
 * legacy.ts — retired installs, in ONE file.
 *
 * `~/.bigbrain/plugin/` is where the hosted-era installer wrote the Claude
 * Code plugin (#645); the desktop app moves it aside at launch
 * (retireHostPluginDir, #693).
 *
 * The pre-rename era used to live here too: the namespace became `bigbrain`
 * on 2026-08-27 (#582), and for one release this file adopted the old env
 * names, moved the old config dir and recognised the old hook marker. The
 * flag day was 2026-09-03 (#522): every install that exists runs the desktop
 * app, which was never on the old side, so the tolerance is gone and nothing
 * in the code spells the old name.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/** `~/.bigbrain/plugin/` — the Claude Code plugin as the hosted installer
 * wrote it, with four `Bash(sh ~/.bigbrain/plugin/scripts/<door>.sh:*)`
 * grants in the user's settings.json naming that literal path. Nothing has
 * written there since #645, so it drifted: a stale copy of the scripts,
 * pre-approved, while Claude Code loaded a different copy (#693). Moved
 * aside — never deleted — to `plugin-retired-<date>` beside it; the grants
 * then name nothing, and `~/.bigbrain/state/` next door is not touched. */
export function retireHostPluginDir(home: string, today: Date = new Date()): { status: "moved" | "none"; from: string; to: string } {
  const from = join(home, ".bigbrain", "plugin");
  let to = join(home, ".bigbrain", `plugin-retired-${today.toISOString().slice(0, 10)}`);
  if (!existsSync(from)) return { status: "none", from, to };
  if (existsSync(to)) to = `${to}-${today.getTime()}`;
  renameSync(from, to);
  return { status: "moved", from, to };
}
