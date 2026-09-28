/**
 * commit.ts — the two mechanical link rewriters every writing pass runs
 * before its commit: follow this run's renames through every inbound
 * link, then canonicalize what this run wrote (#498: the editor's commit
 * spine died with the pass; the memory pass is the surviving caller).
 * Nothing here guesses — an unresolvable or contested link is left
 * exactly as written for checkLinks to report.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeLinks, repairRenames, type Rename } from "../links";

/** Detect working-tree renames through a private index and repair links only
 * within the requested scope. The user's index stays untouched on failed runs. */
export function followRenames(root: string, role: string, scope: string[] = []): number {
  // Detect renames without staging the user's working tree or disturbing their index.
  const temporary = mkdtempSync(join(tmpdir(), "bb-memory-index-"));
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index") } });
    if (result.status !== 0) throw new Error("Could not inspect memory renames");
    return result.stdout;
  };
  let out: string;
  try {
    git(["read-tree", "HEAD"]);
    git(["add", "--", ...(scope.length ? scope : ["."])]);
    out = git(["diff", "--cached", "-M", "--name-status", "HEAD", ...(scope.length ? ["--", ...scope] : [])]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const renames: Rename[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (!parts[0]?.startsWith("R") || parts.length < 3) continue;
    const [, from, to] = parts as [string, string, string];
    if (from.endsWith(".md") && to.endsWith(".md")) renames.push({ from, to });
  }
  if (!renames.length) return 0;

  const res = repairRenames(root, renames, true, scope);
  console.log(
    `${role}: ${renames.length} move(s) — ${res.rewritten} inbound link(s) followed across ${res.filesTouched} file(s)`
  );
  // never silent: a bare link whose old basename another note still
  // answers to is a guess we refuse to make, and checkLinks reports it
  if (res.contested.length)
    console.log(
      `${role}: ${res.contested.length} bare link(s) left alone — another note still answers to that name`
    );
  return res.rewritten;
}

/** Canonicalize the links in exactly these paths — the shared tail of both
 * writers' commit spines (the editor hands it this run's touched notes,
 * the memory pass its whole tree). Returns the number of links rewritten.
 * Nothing here guesses either. */
export function canonicalizeScope(root: string, role: string, paths: string[]): number {
  if (!paths.length) return 0;
  const res = canonicalizeLinks(root, paths, true);
  if (res.rewritten)
    console.log(
      `${role}: canonicalized ${res.rewritten} link(s) across ${res.filesTouched} file(s)`
    );
  // left as written on purpose — checkLinks reports them, a human or the
  // next pass decides. Say so rather than letting it look like a clean run.
  if (res.unmatched.length || res.contested.length)
    console.log(
      `${role}: ${res.unmatched.length} unresolvable and ${res.contested.length} contested link(s) left as written`
    );
  return res.rewritten;
}
