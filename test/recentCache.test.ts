import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceExcerpt, recentSourcePage } from "../lib/sourceFeed";
import { invalidateVaultReadModel } from "../lib/vaultReadModel";
import { createLive } from "../lib/liveEvents";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { insertion } from "./support/vault";

test("bounded excerpts preserve whitespace and truncation semantics", () => {
  for (const body of ["", " \n\t", "a\n b  c", "a".repeat(1000), " x ".repeat(10000), " \n".repeat(1000) + "hello", "x".repeat(239) + "  y", "a\u00a0b\u2003c", "🙂 ".repeat(200)]) {
    expect(sourceExcerpt(body)).toBe(body.trim().replace(/\s+/gu, " ").slice(0, 240));
  }
});

test("recent pages share a feed and watcher events invalidate it before the live debounce", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-recent-cache-"));
  const live = createLive({ root, refresh: () => {}, warmLayout: () => {} });
  try {
    appendSourceInsertionEvent(root, insertion({ id: `ins_${"a".repeat(24)}`, title: "Earlier", received_at: "2026-01-01T00:00:00Z" }));
    const first = recentSourcePage(root, 0, 12);
    expect(first).toEqual(recentSourcePage(root, 0, 12));
    expect(recentSourcePage(root, 0, 3).recent[0]).toEqual(first.recent[0]);
    appendSourceInsertionEvent(root, insertion({ id: `ins_${"b".repeat(24)}`, title: "New arrival", received_at: "2026-01-02T00:00:00Z" }));
    live.handleChange("log/insertions/2026-01/new.json");
    const refreshed = recentSourcePage(root, 0, 1);
    expect(refreshed.recent[0].title).toBe("New arrival");
    expect(refreshed.nextOffset).toBe(1);
    expect(recentSourcePage(root, 1, 12).recent[0].title).toBe("Earlier");
    expect(recentSourcePage(root, 1, 12).nextOffset).toBeNull();
  } finally { live.stop(); invalidateVaultReadModel(root); rmSync(root, { recursive: true, force: true }); }
});
