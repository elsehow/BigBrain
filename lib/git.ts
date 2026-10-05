/**
 * git.ts — machine roles commit as themselves. Git is the "what" journal:
 * `git log --author=editor` (retired eras: =triage/=deep, pre-rename
 * =intake/=librarian) is the activity feed, `git show` the audit
 * trail. Commit messages are computed by code, never written by a model.
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fsx";
import { ENGINE_ROOT } from "./engine";

function git(root: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Neutralize git hooks on the machine COMMIT path (§4.2d). A poisoned clip
 * that writes `.git/hooks/*` in the vault would otherwise get code-exec as
 * the process owner on the next machine commit. Applied to every
 * machine commit (machine commit messages are code-computed and never need
 * a hook). The retired hosted runner's container half enforced the same
 * rule with an empty read-only tmpfs over `.git/hooks`. */
const HOOKLESS = ["-c", "core.hooksPath=/dev/null"];

/** Machine commits are never signed. A user's global `commit.gpgsign=true`
 * would otherwise sign `editor@bigbrain`'s commits with the user's own key —
 * and when that key is absent or locked (an ssh signing key path that
 * doesn't exist, a gpg agent with no tty), every machine commit fails with
 * git's "failed to write commit object", surfacing as a settings save
 * that errors in the UI. The machine is not the user; it has no key. */
const UNSIGNED = ["-c", "commit.gpgsign=false"];

/** Trimmed stdout of a git command in `root` — the read-side helper the
 * editor modules share. Failures surface as "" (callers treat empty as
 * absent), stderr is dropped. */
export function gitOut(root: string, args: string[]): string {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
}

/** Stdout as lines, WITHOUT trimming — for `status --porcelain`, whose
 * first two columns are the status code and whose leading space is
 * therefore DATA. gitOut's trim() eats it on the first line only, so
 * `" M entities/x.md"` became `"M entities/x.md"` and every `slice(3)`
 * parser lost a character off that one path. It bit silently: the
 * mangled path is untracked-looking, so the memory pass journaled a
 * write-scope violation it then failed to revert, and the editor's
 * tripwire failed to exclude the first foreign write from its commit.
 * Parse porcelain through here, never gitOut. */
export function gitLines(root: string, args: string[]): string[] {
  const out = spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter((l) => l.length > 0);
}

/** Stage `paths` and commit as the named machine role. No-op when nothing
 * staged. `exclude` paths are unstaged after the add — e.g. foreign writes a
 * tripwire flagged, which must never ride in a machine commit. */
export function commitAs(
  root: string,
  role: string,
  message: string,
  paths: string[],
  exclude: string[] = []
): boolean {
  git(root, ["add", "--", ...paths]);
  if (exclude.length) git(root, ["reset", "-q", "HEAD", "--", ...exclude]);
  if (git(root, ["diff", "--cached", "--quiet"]).status === 0) return false;
  const r = git(root, [
    ...HOOKLESS,
    ...UNSIGNED,
    "-c",
    `user.name=${role}`,
    "-c",
    `user.email=${role}@bigbrain`,
    "commit",
    "-m",
    message,
  ]);
  if (r.status !== 0) throw new Error(`git commit failed:\n${r.out}`);
  return true;
}

/** Stage `paths` and commit ONLY them (`git commit --only -- <paths>`),
 * leaving whatever else is staged — another writer's in-flight work —
 * untouched in the index. This is the commit shape for writers with no lock
 * over the repo: intake commits landings while the editor may hold
 * entities/inbox staged between its stageWork and commitRun, and a
 * whole-index `commitAs` here would sweep that staged work into a
 * mis-authored commit and empty the index under detectMoves. No-op when
 * nothing under `paths` has changed. */
export function commitPathsOnly(
  root: string,
  role: string,
  message: string,
  paths: string[]
): boolean {
  if (!git(root, ["status", "--porcelain", "--", ...paths]).out.trim()) return false;
  git(root, ["add", "--", ...paths]); // partial commit needs the paths known to git (new files are untracked)
  const r = git(root, [
    ...HOOKLESS,
    ...UNSIGNED,
    "-c",
    `user.name=${role}`,
    "-c",
    `user.email=${role}@bigbrain`,
    "commit",
    "--only",
    "-m",
    message,
    "--",
    ...paths,
  ]);
  if (r.status !== 0) throw new Error(`git commit failed:\n${r.out}`);
  return true;
}

/** Fire-and-forget publish poke after a machine commit. Detached so no
 * writer ever waits on the network; publish.ts itself no-ops on clients,
 * locks against itself, and eats failures (the sweep retries). */
export function pokePublish(root: string): void {
  ensureDir(join(root, ".state", "logs"));
  const log = openSync(join(root, ".state", "logs", "publish.log"), "a");
  // process.execPath, not "bun": a bare-ssh or cron invocation has no
  // ~/.bun/bin on PATH, and the ENOENT lands AFTER the commit — the one
  // crash a fire-and-forget poke exists to avoid. The running binary is
  // by definition findable.
  spawn(process.execPath, [join(ENGINE_ROOT, "bin", "publish.ts")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}
