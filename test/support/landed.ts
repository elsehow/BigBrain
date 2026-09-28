/**
 * What a landing actually recorded.
 *
 * Until 2026-08-30 `receive()` also wrote a gitignored desk copy under
 * inbox/, and tests read the landed bytes back from `receipt.path`. Nothing
 * consumed that copy after #498 and no sweeper cleared it, so it went; the
 * immutable insertion event at `receipt.path` IS the landing now.
 *
 * `landedText` renders the event the way the item arrived — its envelope
 * (the frontmatter the door stamped) over its body — so a test can still
 * ask what the record holds in the words the payload used.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSourceInsertionLog, type SourceInsertion } from "../../lib/insertionLog";

export function landedEvent(root: string, receipt: { path: string }): SourceInsertion {
  if (!receipt.path) throw new Error("receipt carries no path — nothing landed");
  return JSON.parse(readFileSync(join(root, receipt.path), "utf8")) as SourceInsertion;
}

export function landedText(root: string, receipt: { path: string }): string {
  return render(landedEvent(root, receipt));
}

const render = (e: SourceInsertion): string => {
  const fm = Object.entries(e.envelope ?? {})
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `${fm}\n\n${e.body}\n`;
};

/** The landing a door's receipt `id` names — the reference id a client is
 * handed, which is the insertion event's own envelope id. */
export function landedEventById(root: string, id: string): SourceInsertion {
  const hit = readSourceInsertionLog(root).find(
    (e) => e.id === id || e.source_id === id || e.envelope?.["id"] === id
  );
  if (!hit) throw new Error(`no insertion event for ${id}`);
  return hit;
}

export function landedTextById(root: string, id: string): string {
  return render(landedEventById(root, id));
}
