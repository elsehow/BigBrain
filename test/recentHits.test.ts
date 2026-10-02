import { expect, test } from "bun:test";
import { recentHits, nestRecentHits } from "../web/ui/src/lib/recentHits";
import type { RecentEntry } from "../web/ui/src/lib/types";
const row = (id: string, modified: number, extra: Partial<RecentEntry> = {}): RecentEntry => ({
  id, path: `sources/${id}.md`, title: id, modified, author: "Sample", action: "added", type: "source", ...extra,
});
test("notes nest under their source without promoting its timestamp", () => {
  const note = row("note", 30, { about: "clip", excerpt: "Recommended by a colleague" });
  const other = row("other", 20), clip = row("clip", 10);
  const hits = nestRecentHits(recentHits({ recent: [note, other, clip], nextOffset: null }).hits);
  expect(hits.map(h => h.note.path)).toEqual([other.path, clip.path, note.path]);
  expect(hits[2]).toMatchObject({ title: note.excerpt, annotationParent: clip.path, note: { modified: 30 } });
});
test("an annotation stays reachable until its subject arrives on a later page", () => {
  const note = row("note", 30, { about: "clip" }), clip = row("clip", 10);
  const first = recentHits({ recent: [note], nextOffset: 1 });
  expect(nestRecentHits(first.hits)[0]?.annotationParent).toBeUndefined();
  const second = recentHits({ recent: [clip], nextOffset: null });
  const combined = nestRecentHits([...first.hits, ...second.hits]);
  expect(combined.map(h => h.note.path)).toEqual([clip.path, note.path]);
  expect(combined[1]?.annotationParent).toBe(clip.path);
});
test("URL annotations nest but independent captures of the same URL remain sources", () => {
  const url = "https://example.com/report";
  const rows = [row("note", 30, { category: "annotation", url }), row("clip", 20, { url }), row("earlier", 10, { url })];
  const hits = nestRecentHits(recentHits({ recent: rows, nextOffset: null }).hits);
  expect(hits.map(h => h.note.path)).toEqual([rows[1]!.path, rows[0]!.path, rows[2]!.path]);
  expect(hits[1]?.annotationParent).toBe(rows[1]!.path);
  expect(hits[2]?.annotationParent).toBeUndefined();
});
