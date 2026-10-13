/** runRecords.ts — a stage's run records are committed with its runs
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R2). A run record is
 * what alone says how a stage's output was made: the model a gardener round
 * ran, what a feed call placed, what the worth gate passed. Left uncommitted,
 * a lost checkout loses it while the output it explains survives.
 *
 * A stage commits as its own role, and only its own records: every record
 * under its journal directory not yet committed, so one whose commit failed
 * (a concurrent index lock) rides the next, as a landing sweeps an orphaned
 * landing (lib/references.ts landingPaths). Additions only, since a record
 * is written once; a stage that appends to a month's file (the worth gate)
 * says so, and its own appends ride too. Nothing flat beside the records
 * (tend's door.json, a last-run trace) is a record. Fail-soft: a record is
 * safe on disk, and the next commit sweeps it. */
import { commitPathsOnly, gitLines, gitOut } from "./git";

export interface RunRecordCommit {
  /** The stage's journal directory, vault-relative. */
  dir: string;
  /** The author of the commit. */
  role: string;
  summary: string;
  /** Records are month files the stage appends to (`<dir>/YYYY-MM.jsonl`),
   * not one file per run (`<dir>/YYYY-MM/<id>.json`). */
  appended?: boolean;
}

/** The records a commit would carry now. */
export function uncommittedRunRecords(root: string, { dir, appended }: Pick<RunRecordCommit, "dir" | "appended">): string[] {
  const record = appended ? /^\d{4}-\d{2}\.jsonl$/u : /^\d{4}-\d{2}\/[^/]+\.json$/u;
  return gitLines(root, ["status", "--porcelain", "-uall", "--", dir])
    .filter((line) => line.startsWith("??") || line.startsWith("A") || (appended && /^( M|M )/u.test(line)))
    .map((line) => line.slice(3).trim().replace(/^"|"$/gu, ""))
    .filter((path) => path.startsWith(`${dir}/`) && record.test(path.slice(dir.length + 1)));
}

/** Commit them. True when a commit was made. */
export function commitRunRecords(root: string, opts: RunRecordCommit): boolean {
  if (!gitOut(root, ["rev-parse", "--git-dir"])) return false; // not a repo: nothing to record
  try {
    const paths = uncommittedRunRecords(root, opts);
    return paths.length ? commitPathsOnly(root, opts.role, opts.summary, paths) : false;
  } catch (error) {
    console.error(`${opts.role}: run record commit failed (records remain safe on disk; the next commit sweeps them): ${error}`);
    return false;
  }
}
