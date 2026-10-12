import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mdVault, insertion } from "./support/vault";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { recentSourcePage, recentSourcePageAsync } from "../lib/sourceFeed";
import { invalidateVaultReadModel } from "../lib/vaultReadModel";
import { appendAndProjectDecline, projectSourceInsertion, recoverAssertionProjection } from "../lib/assertionProjection";
import { createDeclineEvent } from "../lib/declineLog";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mdVault(); roots.push(root);
  const a = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a", title: "First", envelope: { source: "email" } });
  const b = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b", title: "Second", received_at: "2026-09-20T00:00:00Z" });
  appendSourceInsertionEvent(root, a);
  return { root, a, b };
}

test("direct cold feed readers preserve ordering, pagination, filters and filing changes", async () => {
  const { root, a, b } = fixture(); appendSourceInsertionEvent(root, b);
  let yielded = false; setTimeout(() => { yielded = true; }, 0);
  const pages = await Promise.all([recentSourcePageAsync(root, 0, 1), recentSourcePageAsync(root, 1, 1), recentSourcePageAsync(root, 0, 10, "EMAIL")]);
  expect(yielded).toBe(true);
  expect(pages).toEqual([recentSourcePage(root, 0, 1), recentSourcePage(root, 1, 1), recentSourcePage(root, 0, 10, "EMAIL")]);
  expect(pages[0]).toMatchObject({ total: 2, nextOffset: 1, recent: [{ title: "Second" }] });
  expect(pages[1]).toMatchObject({ nextOffset: null, recent: [{ title: "First" }] });
  expect(pages[2]).toMatchObject({ total: 1, recent: [{ title: "First" }] });
  appendAndProjectDecline(root, createDeclineEvent({ insertion_ids: [a.id], reason: "Boilerplate",
    author: { kind: "agent", id: "test" }, produced_by: { procedure: "test", version: "1" },
    created_at: "2026-09-20T00:00:00Z" }, new Map([[a.id, a]])));
  expect((await recentSourcePageAsync(root, 1, 1)).recent[0]!.status).toBe("declined");
});

test("a change during preparation cannot satisfy freshness with an obsolete result", async () => {
  const { root, b } = fixture();
  const first = recentSourcePageAsync(root, 0, 10);
  appendSourceInsertionEvent(root, b); projectSourceInsertion(root, b); invalidateVaultReadModel(root);
  const second = recentSourcePageAsync(root, 0, 10);
  const pages = await Promise.all([first, second]);
  expect(pages[0]).toEqual(pages[1]); expect(pages[0]!.total).toBe(2);
});

test("an unannounced engine write is read at once; a hand-written log file waits for recovery", async () => {
  const { root, b } = fixture();
  const c = insertion({ id: `ins_${"c".repeat(24)}`, source_id: "c", title: "Third" });
  const clock = Date.now; let now = clock(); Date.now = () => now;
  try {
    expect((await recentSourcePageAsync(root, 0, 10)).total).toBe(1);
    // Another process's landing projects itself: no hint, watcher or clock.
    appendSourceInsertionEvent(root, b); projectSourceInsertion(root, b);
    expect((await recentSourcePageAsync(root, 0, 10)).total).toBe(2);
    // The fallback clock reconciles Markdown only: a log file written by hand,
    // which no engine write projected, waits for recovery's census.
    mkdirSync(join(root, insertionEventRel(c), ".."), { recursive: true });
    writeFileSync(join(root, insertionEventRel(c)), JSON.stringify(c));
    now += 1000;
    expect((await recentSourcePageAsync(root, 0, 10)).total).toBe(2);
    recoverAssertionProjection(root);
    expect((await recentSourcePageAsync(root, 0, 10)).total).toBe(3);
  } finally { Date.now = clock; }
});

test("failed preparation rejects and can be retried after repair", async () => {
  const { root, a } = fixture();
  writeFileSync(join(root, insertionEventRel(a)), "broken json");
  await expect(recentSourcePageAsync(root, 0, 10)).rejects.toThrow("unreadable event");
  writeFileSync(join(root, insertionEventRel(a)), JSON.stringify(a));
  expect((await recentSourcePageAsync(root, 0, 10)).total).toBe(1);
});
