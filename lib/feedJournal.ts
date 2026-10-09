/** feedJournal.ts — the feed stage's journal (lib/feedStage.ts): one record
 * per model call, none ever overwritten. Read-only helpers, kept apart from
 * the stage so a reader (`bigbrain feed`, the viewer) need not load the runner.
 *
 * The journal is the stage's whole state. Its checkpoint is the union of the
 * assertions closed records read; its schedule is the last attempt plus the
 * interval; the feed itself is each conversation's newest entry. Delete
 * `.state/` and nothing is lost. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunUsage } from "./run/model";

export const FEED_JOURNAL_DIR = "journal/feed";

export const FEED_SECTIONS = ["needs-you", "agent", "know", "skip"] as const;
export type FeedSection = (typeof FEED_SECTIONS)[number];

/** One source's place in the feed, as one call judged it. */
export interface FeedEntry {
  /** The source insertion the claims came from (or the assertion id, for a
   * legacy assertion that names none). */
  source: string;
  section: FeedSection;
  headline: string;
  /** YYYY-MM-DD after which the entry no longer matters, or null. */
  expires: string | null;
  /** The assertions this entry was judged from. */
  assertions: string[];
}

export interface FeedRecord {
  format: "bigbrain-feed-run/v1";
  invocation_id: string;
  /** Every assertion this call read: the checkpoint is their union. */
  assertions: string[];
  entries: FeedEntry[];
  prompt_version: string;
  started_at: string;
  completed_at: string;
  model?: string;
  usage?: RunUsage;
  error?: { message: string };
}

export function feedRecords(root: string): FeedRecord[] {
  const base = join(root, FEED_JOURNAL_DIR);
  let months: string[];
  try {
    months = readdirSync(base).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  } catch {
    return [];
  }
  const out: FeedRecord[] = [];
  for (const month of months)
    for (const f of readdirSync(join(base, month)).filter((n) => n.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(readFileSync(join(base, month, f), "utf8")) as FeedRecord);
      } catch { /* a damaged record is skipped, never fatal */ }
    }
  return out.sort((a, b) => a.completed_at.localeCompare(b.completed_at) || a.invocation_id.localeCompare(b.invocation_id));
}

/** The assertions some successful call has read: the stage's checkpoint. A
 * failed call reads nothing, so its assertions stay due. */
export const sortedAssertions = (records: FeedRecord[]): Set<string> =>
  new Set(records.filter((r) => !r.error).flatMap((r) => r.assertions));

/** When each source entered the feed: the first call that put it in a
 * section other than skip. A later re-judgment keeps that time. */
export function addedAt(records: FeedRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) if (!r.error) for (const e of r.entries) if (e.section !== "skip" && !out.has(e.source)) out.set(e.source, r.completed_at);
  return out;
}

/** The feed as it stands: each conversation's newest entry, without skips
 * and without entries whose date has passed. `today` is a local YYYY-MM-DD;
 * `conversationOf` names an entry's conversation (lib/feedConversation.ts),
 * each source its own when not given. */
export function currentFeed(records: FeedRecord[], today: string, conversationOf: (source: string) => string = (s) => s): FeedEntry[] {
  const latest = new Map<string, FeedEntry>();
  for (const r of records) if (!r.error) for (const e of r.entries) latest.set(conversationOf(e.source), e);
  return [...latest.values()].filter((e) => e.section !== "skip" && !(e.expires && e.expires < today));
}
