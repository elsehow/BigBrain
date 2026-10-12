/** runJournal.ts — where the passes keep their run journals: one JSON record
 * per run, written once and whole under `journal/<pass>/<YYYY-MM>/<id>.json`
 * and never rewritten. Tend's name each round's model and when it ran
 * (lib/tend.ts); the feed stage's place sources in the sorted feed
 * (lib/feedJournal.ts). The projection reads both (projectJournal). */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const TEND_JOURNAL_DIR = "journal/tend";
export const FEED_JOURNAL_DIR = "journal/feed";

/** Every record under `dir` (one of the above), oldest first, as
 * vault-relative paths. Anything flat beside the month shards (tend's
 * door.json) is not a run. */
export function runJournalFiles(root: string, dir: string): string[] {
  let months: string[];
  try {
    months = readdirSync(join(root, dir)).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  } catch {
    return [];
  }
  return months.flatMap((month) => {
    try {
      return readdirSync(join(root, dir, month)).filter((f) => f.endsWith(".json")).sort().map((f) => `${dir}/${month}/${f}`);
    } catch {
      return [];
    }
  });
}
