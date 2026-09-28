/**
 * bigbrainCommand.ts — the `bigbrain` command on PATH (`~/.local/bin/bigbrain`)
 * and which engine it runs. Two writers:
 *
 *   `bigbrain install`   a symlink to `<checkout>/bin/cli.ts` (bin/install.ts)
 *   BigBrain.app         a shell shim that runs the engine inside the app with
 *                        the app's own bun, naming that engine on a
 *                        `# engine: <path>` line (desktop/src-tauri/src/lib.rs)
 *
 * The app rewrites its shim on every launch and takes a CLI install's
 * symlink over: on a machine running the app, the command and the app run
 * the same code (desktop/README.md, "Which engine runs"). Readers here
 * (preflight, install) ask one question of either form — which engine root
 * does the command run?
 */

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The first comment line of the app's shim; the Rust side spells the same
 * string (SHIM_MARKER) and neither may drift. */
export const APP_SHIM_MARKER = "# installed by BigBrain.app";

export function bigbrainCommandPath(home: string = homedir()): string {
  return join(home, ".local", "bin", "bigbrain");
}

/** Is the command at `link` the desktop app's shim? */
export function isAppShim(link: string): boolean {
  try {
    return lstatSync(link).isFile() && readFileSync(link, "utf8").includes(APP_SHIM_MARKER);
  } catch {
    return false;
  }
}

/** The engine root the command at `link` runs: the checkout behind an
 * install's symlink, the engine the app's shim names, or null — no command,
 * or one that is neither (a person's own script, a symlink to something
 * that is not an engine's `bin/cli.ts`). */
export function engineBehindCommand(link: string): string | null {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(link);
    const abs = isAbsolute(target) ? target : resolve(dirname(link), target);
    if (basename(abs) !== "cli.ts" || basename(dirname(abs)) !== "bin") return null;
    return resolve(dirname(dirname(abs)));
  }
  if (!st.isFile()) return null;
  const text = readFileSync(link, "utf8");
  if (!text.includes(APP_SHIM_MARKER)) return null;
  const line = text.split("\n").find((l) => l.startsWith("# engine: "));
  const named = line?.slice("# engine: ".length).trim();
  return named ? resolve(named) : null;
}
