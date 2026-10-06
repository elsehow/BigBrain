/**
 * What the @ menu (PilotMentionComposer) offers in a desktop's composer:
 * the items most recently added to the vault, and, once you type, the
 * vault's search (/api/search, the same endpoint the app's search uses).
 */
import type { MentionItem } from "../../../../lib/pilotMentions";
import { api } from "./api";
import type { SearchHit } from "./omnibox.svelte";
import type { RecentEntry } from "./types";
import { titleOf } from "./utils";

const dirOf = (path: string) =>
  path.startsWith("memory/") ? "memory" : path.startsWith("projection/entities/") ? "projection/entities" : "source";

function dateLabel(ms: number | undefined): string {
  const date = ms && Number.isFinite(ms) ? new Date(ms) : null;
  if (!date) return "";
  const dateOnly = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return dateOnly ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
}

export function mentionItem(hit: Pick<SearchHit, "dir" | "note" | "title">): MentionItem {
  return { id: hit.note.path, title: hit.title || titleOf(hit.note.name),
    tag: hit.dir === "memory" ? "MEMORY" : hit.dir === "projection/entities" ? "ENTITY" : "SOURCE",
    date: dateLabel(hit.note.modified) };
}

const recentItem = (row: RecentEntry): MentionItem =>
  mentionItem({ dir: dirOf(row.path), title: row.title ?? "", note: { path: row.path, name: row.path.split("/").at(-1)!, modified: row.modified, size: 0 } });

/** The most recently added notes, a page at a time from `offset`; `next`
 * is where the following page starts, or null at the oldest. */
export async function mentionRecents(offset = 0, signal?: AbortSignal): Promise<{ items: MentionItem[]; next: number | null }> {
  const page = await api.recent(30, offset, signal);
  return { items: page.recent.map(recentItem), next: page.nextOffset };
}

/** The whole vault, searched as the app's search does. */
export async function mentionSearch(query: string, signal: AbortSignal): Promise<MentionItem[]> {
  const page = await api.searchPage(query, 0, 50, signal, true);
  return page.hits.filter((hit) => hit.dir !== "pilot").map(mentionItem);
}
