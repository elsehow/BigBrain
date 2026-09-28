/**
 * noteLog.ts — a single note's "touched by" record (phase 4 of
 * docs/plans/2026-07-25-lake-vault-queue.md, "surfaces"): merges three
 * sources into one newest-first timeline —
 *
 *   (a) frontmatter provenance — the note's own envelope: when it landed
 *       (`received`/`date`/`fetched`) and, for a filed note, the
 *       `filed`+`triage_run` stamp the retired editor's detectFiled wrote.
 *   (b) git history — `git log --follow` for the path, bounded to the most
 *       recent commits; author persona (triage/deep/config/intake/a human)
 *       is the actor, same personas the activity feed already uses.
 *   (c) queue journal entries — journal/{queue,triage,deep,intake,librarian}
 *       records whose own `commit` field matches one of this note's git
 *       commits (the execution that produced that commit), scanned bounded
 *       (newest files first, capped) rather than indexed. Legacy
 *       journal/triage,/deep records predate the queue and carry no
 *       `commit`/`lane` field the same way, so a plain text match against
 *       the note's path/id catches those (their `moved`/`items`/`requests`
 *       arrays are literal path/id lists).
 *
 * Read-only, and side-effect-free at import.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope, type Envelope } from "./envelope";
import { gitOut } from "./git";
import { parseNoteDate } from "./noteMeta";
import { journalFiles, readQueueJournalFile } from "./run/journal";

export interface LogRow {
  at: number; // epoch ms
  actor: string;
  action: string;
}

/** fast→triage, slow→deep — the RETIRED lane split's personas (lanes were
 * removed 2026-08-02; new journal records carry no `lane` field and resolve
 * to `editor`). Kept so pre-removal queue records keep naming their true
 * author — history stays truthful. */
const LANE_ROLE: Record<string, string> = { fast: "triage", slow: "deep" };

/** journal/<dir>/ trees scanned for a note's touches — the queue era plus
 * the pre-queue single-editor eras it superseded. */
const JOURNAL_DIRS = ["queue", "triage", "intake", "deep", "librarian"];

/** journal files (per dir) scanned per lookup — newest-named first. Bounded
 * so a note-log request on a long-lived vault stays cheap; older touches
 * still show via git history even once they age out of this window. */
export const JOURNAL_SCAN_CAP = 500;

/** The persona ("editor", or the retired "triage"/"deep") that a
 * `triage_run` frontmatter stamp names, resolved through the journal: a
 * current queue record (journal/queue/<runId>.json) is the editor's; a
 * pre-2026-08-02 record still carries its `lane`, mapped through LANE_ROLE;
 * a legacy record is identified by which dir holds it. This is the
 * AUTHORITATIVE "who filed it" — the filing run's own record — where a git
 * author is only the note's most-recent committer (a later machine/human
 * edit would misattribute the filing). Undefined when no record survives
 * (the caller keeps its fallback). runId is frontmatter text, so it is
 * shape-checked before touching a path. */
export function runRole(root: string, runId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return undefined;
  const queueRec = join(root, "journal", "queue", `${runId}.json`);
  if (existsSync(queueRec)) {
    const rec = readQueueJournalFile(queueRec)?.record;
    if (!rec) return undefined;
    const lane = rec.lane ?? "";
    return lane ? (LANE_ROLE[lane] ?? lane) : "editor";
  }
  for (const [dir, role] of [
    ["triage", "triage"],
    ["intake", "triage"],
    ["deep", "deep"],
    ["librarian", "deep"],
  ] as const)
    if (existsSync(join(root, "journal", dir, `${runId}.json`))) return role;
  return undefined;
}

/** The MODEL a `triage_run` stamp's run executed with, resolved through the
 * journal: every era's record carries a `model` field (queue records write
 * cap.model, legacy triage/deep records their pass model). This is what the
 * feed's filed-by column may truthfully show for a machine-synthesized note
 * — the model that did the work — where the pass persona (runRole) is an
 * internal name the audit log keeps but the feed must not wear. Undefined
 * when no record survives or it carries no model: the caller shows nothing
 * rather than fabricating a label. Same shape-check as runRole — runId is
 * frontmatter text.
 *
 * Named for what it answers (#640): it LOOKS UP which model ran a recorded
 * run. `runModel` also names lib/run/model.ts's dispatcher, which SPAWNS
 * one — two different verbs under one word. */
export function journalModelFor(root: string, runId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return undefined;
  for (const dir of JOURNAL_DIRS) {
    const rec = join(root, "journal", dir, `${runId}.json`);
    if (!existsSync(rec)) continue;
    const parsed = readQueueJournalFile(rec)?.record;
    if (!parsed) return undefined;
    const model = parsed.model?.trim() ?? "";
    return model || undefined;
  }
  return undefined;
}

/** Commit-subject → action-word heuristic for a git row. Author personas are
 * few and well-known: `intake` lands references, `config` writes vault.yaml/
 * prompts, `editor` (and the retired `triage`/`deep`) commit
 * `"<role>: <verb> …"` (see worker.ts's commitWork), anything else is a
 * human editing directly. */
export function commitAction(author: string, subject: string): string {
  if (author === "intake") return "landed";
  if (author === "config") return "configured";
  const m = /^(?:editor|triage|deep):\s*([a-z]+)/.exec(subject);
  if (m) return m[1]!;
  return "edited";
}

/** Frontmatter provenance rows for one note's already-parsed envelope
 * (merge source a). At most one submission row (the most-trusted key that
 * parses wins — `received` over `date` over `fetched`, mirroring
 * lib/noteMeta.ts's fmProvenance), plus a `filed` row when the note carries
 * the detectFiled stamp. */
export function frontmatterLogRows(env: Envelope): LogRow[] {
  const rows: LogRow[] = [];
  const from = typeof env.from === "string" ? env.from.trim() : undefined;
  const source = typeof env.source === "string" ? env.source.trim() : undefined;
  const actor = from || source || "intake";
  for (const [key, action] of [
    ["received", "landed"],
    ["date", "composed"],
    ["fetched", "fetched"],
  ] as const) {
    const v = env[key];
    if (typeof v !== "string") continue;
    const t = parseNoteDate(v.trim());
    if (Number.isNaN(t)) continue;
    rows.push({ at: t, actor, action });
    break;
  }
  if (typeof env.filed === "string") {
    const t = parseNoteDate(env.filed.trim());
    if (!Number.isNaN(t)) {
      const runId = typeof env.triage_run === "string" ? env.triage_run.trim() : "";
      rows.push({ at: t, actor: runId ? `run ${runId}` : "editor", action: "filed" });
    }
  }
  return rows;
}

/** One `git log --follow` row for the path (merge source b), bounded to the
 * most recent `limit` commits. Rename-following means a note's log survives
 * the editor moving/renaming it. */
export function gitLogRows(
  root: string,
  path: string,
  limit = 30
): { rows: LogRow[]; shas: Set<string> } {
  const raw = gitOut(root, [
    "log",
    "--follow",
    "-n",
    String(limit),
    "--pretty=format:%H\x01%aI\x01%an\x01%s",
    "--",
    path,
  ]);
  const rows: LogRow[] = [];
  const shas = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [sha, iso, an, subject] = line.split("\x01");
    if (!sha) continue;
    shas.add(sha);
    const at = Date.parse(iso ?? "");
    if (Number.isNaN(at)) continue;
    rows.push({ at, actor: an || "unknown", action: commitAction(an ?? "", subject ?? "") });
  }
  return { rows, shas };
}

/** Bounded scan of the journal dirs for entries touching this note (merge
 * source c): a queue-era record whose own `commit` matches one of the
 * note's git commits (the execution that produced it), or — any dir,
 * queue-era or legacy — a record whose raw JSON text mentions the note's
 * path or id (legacy journal/triage,/deep records carry literal
 * `moved`/`items`/`requests` path lists; a text match is schema-agnostic by
 * design, so this survives those shapes evolving). */
export function journalLogRows(
  root: string,
  opts: { path: string; id?: string; commitShas?: ReadonlySet<string>; cap?: number }
): LogRow[] {
  const shas = opts.commitShas ?? new Set<string>();
  const cap = opts.cap ?? JOURNAL_SCAN_CAP;
  const rows: LogRow[] = [];
  for (const dir of JOURNAL_DIRS) {
    const abs = join(root, "journal", dir);
    for (const { path } of journalFiles(abs).reverse().slice(0, cap)) {
      const file = readQueueJournalFile(path);
      if (!file) continue;
      const { raw, record: rec } = file;
      // A stage pre-pass record (#308) names dossier paths in its VERDICTS —
      // an opinion about a note, not a touch of it. Without this skip every
      // entity a shadow drain resolved would grow a phantom history row.
      if (rec.stage) continue;
      const mentionsCommit = !!rec.commit && typeof rec.commit === "string" && shas.has(rec.commit);
      const mentionsText = raw.includes(opts.path) || (!!opts.id && raw.includes(opts.id));
      if (!mentionsCommit && !mentionsText) continue;
      const at = rec.startedAt ? Date.parse(rec.startedAt) : NaN;
      if (Number.isNaN(at)) continue;
      const lane = rec.lane;
      const actor = lane
        ? (LANE_ROLE[lane] ?? lane)
        : dir === "queue"
          ? "editor"
          : dir === "librarian"
            ? "deep"
            : dir === "intake"
              ? "triage"
              : dir;
      const action = rec.verb ?? "run";
      rows.push({ at, actor, action });
    }
  }
  return rows;
}

/** Newest-first, deduped (exact at/actor/action triple — the same
 * touch can legitimately surface from more than one source, e.g. a git
 * commit AND its matching journal entry share a timestamp/actor/verb).
 * Pure — the merge point of sources a/b/c. */
export function mergeNoteLog(
  sources: { provenanceRows: LogRow[]; gitRows: LogRow[]; journalRows: LogRow[] },
  limit = 50
): LogRow[] {
  const seen = new Set<string>();
  const rows: LogRow[] = [];
  for (const r of [...sources.provenanceRows, ...sources.gitRows, ...sources.journalRows]) {
    const key = `${r.at}\t${r.actor}\t${r.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** The full "touched by" log for one note, vault-relative `path`. Reads the
 * note itself (for its envelope — absent/unreadable degrades to no
 * provenance rows, never a throw), its bounded git history, and the bounded
 * journal scan keyed off those commits. */
export function noteLog(root: string, path: string, limit = 50): LogRow[] {
  let env: Envelope = {};
  try {
    env = parseEnvelope(readFileSync(join(root, path), "utf8")).envelope;
  } catch {
    /* unreadable/gone — provenance rows just come back empty */
  }
  const id = typeof env.id === "string" ? env.id : undefined;
  const { rows: gitRows, shas } = gitLogRows(root, path);
  const journalRows = journalLogRows(root, { path, id, commitShas: shas });
  const provenanceRows = frontmatterLogRows(env);
  return mergeNoteLog({ provenanceRows, gitRows, journalRows }, limit);
}
