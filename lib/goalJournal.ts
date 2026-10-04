/** goalJournal.ts — the goal chain's journal of pictures (#51): every picture
 * the Memory stage wrote, none ever overwritten. Read-only helpers, kept apart
 * from lib/goalChain.ts so a reader (load_memory) need not load the runner. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunUsage } from "./run/model";

export const GOAL_JOURNAL_DIR = "journal/goals";

// ── the picture journal: the stage's record and its checkpoint ─────────────

export interface PictureRecord {
  format: "bigbrain-goal-picture/v1";
  invocation_id: string;
  /** The picture itself; unchanged from the last when nothing new arrived. */
  picture: string;
  /** The arrival-time window this picture closes: [from, through). */
  covers: { from: string; through: string };
  /** Goal events folded in by THIS picture — the checkpoint is their union. */
  events: string[];
  /** False when the window brought no goal assertions: no model was called. */
  rebuilt: boolean;
  prompt_version: string;
  started_at: string;
  completed_at: string;
  model?: string;
  usage?: RunUsage;
  error?: { message: string };
}

export function pictureRecords(root: string): PictureRecord[] {
  const base = join(root, GOAL_JOURNAL_DIR);
  let months: string[];
  try {
    months = readdirSync(base).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  } catch {
    return [];
  }
  const out: PictureRecord[] = [];
  for (const month of months)
    for (const f of readdirSync(join(base, month)).filter((n) => n.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(readFileSync(join(base, month, f), "utf8")) as PictureRecord);
      } catch { /* a damaged record is skipped, never fatal */ }
    }
  return out.sort((a, b) => a.covers.through.localeCompare(b.covers.through) || a.completed_at.localeCompare(b.completed_at));
}

/** The pictures that closed their window — a failed build closes nothing. */
export const closed = (records: PictureRecord[]): PictureRecord[] => records.filter((r) => !r.error);

/** The goal events some picture has folded in: the stage's checkpoint. */
export const foldedEvents = (records: PictureRecord[]): Set<string> => new Set(closed(records).flatMap((r) => r.events));

/** The newest picture that closed its window. */
export function latestPicture(root: string): PictureRecord | undefined {
  return closed(pictureRecords(root)).at(-1);
}

