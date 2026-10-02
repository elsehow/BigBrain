import { nestNotes, noteLabel } from "./feed";
import type { SearchHit } from "./omnibox.svelte";
import type { RecentEntry } from "./types";

export function recentHits(page: { recent: RecentEntry[]; nextOffset: number | null }) {
  return { nextOffset: page.nextOffset, hits: page.recent.map(row => ({
    dir: row.path.startsWith("memory/") ? "memory" : row.path.startsWith("projection/entities/") ? "projection/entities" : "source",
    note: { path: row.path, name: row.path.split("/").at(-1)!, modified: row.modified, size: 0 },
    title: row.title ?? "", snippet: "", sessionId: row.sessionId, from: row.from, recentEntry: row,
  })) };
}

/** Group after pages accumulate, so an annotation can find a subject on a later page. */
export function nestRecentHits(hits: SearchHit[]): SearchHit[] {
  const byPath = new Map(hits.map(hit => [hit.note.path, hit]));
  const rows = hits.map(hit => hit.recentEntry ?? {
    path: hit.note.path, title: hit.title, modified: hit.note.modified ?? 0, author: "", action: "added",
  } as RecentEntry);
  return nestNotes(rows).flatMap(({ row, notes }) => [byPath.get(row.path)!, ...notes.map(note => ({
    ...byPath.get(note.path)!, title: noteLabel(note), annotationParent: row.path,
  }))]);
}
