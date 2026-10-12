import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAssertionEvent,
  assertionEntityId,
  createAssertionEvent,
  readAssertionLog,
  type AssertionEvent,
} from "../lib/assertionLog";
import {
  appendAndProjectAssertion,
  assertionsWithRefsForEntity,
  syncAssertionProjection,
  assertionProjectionDigest,
  assertionProjectionStats,
  projectSourceInsertion,
  projectedSourcesById,
  claimProjectionRecovery,
  rebuildAssertionProjection,
  recoverAssertionProjection,
  searchAssertionEntities,
  searchAssertionProjection,
  searchAssertionSources,
} from "../lib/assertionProjection";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { insertion } from "./support/vault";

/** Sync as a read does, then count what the projection holds. */
const synced = (root: string) => { syncAssertionProjection(root); return assertionProjectionStats(root); };

const source = (id = "ins_meeting", sourceId = "meeting-1"): SourceInsertion =>
  insertion({
    id,
    source_id: sourceId,
    author: { kind: "service", id: "granola" },
    title: "Research conversation",
    body: "Ada said the Atlas experiment should test sparse probes. Ben agreed to run it next Tuesday.",
    occurred_at: "2026-08-18T10:00:00.000Z",
  });

const assertion = (item: SourceInsertion, invocation = "run-1"): AssertionEvent => {
  const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
  const atlas = { id: assertionEntityId("Atlas experiment"), label: "Atlas experiment" };
  return createAssertionEvent({
    text: `[[${ada.id}|Ada]] said the [[${atlas.id}|Atlas experiment]] should test sparse probes.`,
    entities: [ada, atlas],
    sources: [item.id],
    author: { kind: "model", id: "gpt-test", invocation_id: invocation },
    confidence: "direct",
    created_at: "2026-08-18T11:00:00.000Z",
    produced_by: { procedure: "intake-agent", version: "v1", invocation_id: invocation, prompt_version: "p1" },
  }, new Map([[item.id, item]]));
};

describe("ontology-free assertion substrate", () => {
  test("constructs source-referenced events and appends them immutably", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-log-"));
    const item = source();
    const event = assertion(item);
    expect(event.sources).toEqual([{ insertion_id: item.id, source_id: item.source_id }]);
    expect(event.citations).toBeUndefined();
    const first = appendAssertionEvent(root, event);
    expect(first.path).toBe(`log/assertions/2026-08/${event.id}.json`);
    expect(first.deduped).toBe(false);
    expect(appendAssertionEvent(root, event).deduped).toBe(true);
    expect(readAssertionLog(root, { strict: true })).toEqual([event]);
    expect(() => appendAssertionEvent(root, { ...event, text: `${event.text} changed` }))
      .toThrow("immutable event collision");
  });

  test("rejects unknown links, preserves legacy quote validation, and rejects damaged history", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-invalid-"));
    const item = source();
    expect(() => createAssertionEvent({
      text: "[[ent_00000000000000000000|Ada]] made a cited claim.", entities: [],
      sources: [item.id],
      author: { kind: "model", id: "gpt-test", invocation_id: "run-links" }, confidence: "candidate",
      created_at: "2026-08-18T11:00:00.000Z",
      produced_by: { procedure: "intake-agent", version: "v1" },
    }, new Map([[item.id, item]]))).toThrow("undeclared entity link");
    expect(() => createAssertionEvent({
      text: "[[ent_00000000000000000000|Ada]] made an unsupported claim.", entities: [],
      citations: [{ insertion_id: item.id, quotes: ["not present"] }],
      author: { kind: "model", id: "gpt-test", invocation_id: "run-x" }, confidence: "candidate",
      created_at: "2026-08-18T11:00:00.000Z",
      produced_by: { procedure: "intake-agent", version: "v1" },
    }, new Map([[item.id, item]]))).toThrow("quote is not exact source text");
    mkdirSync(join(root, "log", "assertions", "2026-08"), { recursive: true });
    writeFileSync(join(root, "log", "assertions", "2026-08", "bad.json"), "{}\n");
    expect(() => readAssertionLog(root, { strict: true })).toThrow("unreadable event");
  });

  test("incrementally indexes sources, assertions, entities, and evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-projection-"));
    const item = source();
    appendSourceInsertionEvent(root, item);
    expect(projectSourceInsertion(root, item)).toBe(true);
    expect(projectSourceInsertion(root, item)).toBe(false);
    const event = assertion(item);
    expect(appendAndProjectAssertion(root, event).deduped).toBe(false);
    expect(appendAndProjectAssertion(root, event).deduped).toBe(true);
    expect(assertionProjectionStats(root)).toEqual({ sources: 1, assertions: 1, entities: 2, source_links: 1 });
    expect(searchAssertionProjection(root, "sparse probes").map((hit) => hit.id)).toEqual([event.id]);
    expect(searchAssertionSources(root, "Research conversation")).toEqual([
      expect.objectContaining({ insertion_id: item.id, source_id: item.source_id, title: item.title }),
    ]);
    expect(projectedSourcesById(root, [item.id]).get(item.id)).toEqual(item);
    expect(searchAssertionEntities(root, "Atlas")).toEqual([
      expect.objectContaining({ id: assertionEntityId("Atlas experiment"), label: "Atlas experiment", assertions: 1 }),
    ]);
    expect(assertionsWithRefsForEntity(root, assertionEntityId("Ada Lovelace"), 20).map((row) => row.id))
      .toEqual([event.id]);
  });

  test("a current projection is confirmed on a read-only connection — no write per keystroke", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-sync-ro-"));
    const item = source();
    appendSourceInsertionEvent(root, item);
    appendAssertionEvent(root, assertion(item));
    expect(synced(root)).toEqual({ sources: 1, assertions: 1, entities: 2, source_links: 1 });
    // Search freshens the projection once a second while someone types. With
    // nothing pending, sync must not open for write at all: a read-only file
    // makes any write path throw ("attempt to write a readonly database").
    const dbPath = join(root, ".state", "assertions.db");
    chmodSync(dbPath, 0o444);
    try {
      expect(synced(root)).toEqual({ sources: 1, assertions: 1, entities: 2, source_links: 1 });
    } finally { chmodSync(dbPath, 0o644); }
    // A new event still takes the write path.
    const second = source("ins_second", "meeting-2");
    appendSourceInsertionEvent(root, second);
    projectSourceInsertion(root, second);
    expect(synced(root).sources).toBe(2);
  });

  test("a read never takes the log census: a file put in log/ by hand waits for recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-recover-"));
    const item = source();
    appendSourceInsertionEvent(root, item);
    // The first read in a process recovers, so files from before it count.
    expect(synced(root).sources).toBe(1);
    // An engine write projects itself; the next read sees it with no census.
    const landed = source("ins_landed", "meeting-2");
    appendSourceInsertionEvent(root, landed);
    projectSourceInsertion(root, landed);
    expect(synced(root).sources).toBe(2);
    // A durable file nothing projected (a crash mid-landing, a hand copy).
    appendSourceInsertionEvent(root, source("ins_by_hand", "meeting-3"));
    expect(synced(root).sources).toBe(2);
    expect(recoverAssertionProjection(root).sources).toBe(3);
    expect(synced(root).sources).toBe(3);
  });

  test("sync is incremental (#456): already-projected files are never reread; new files are picked up", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-sync-"));
    const item = source();
    const landed = appendSourceInsertionEvent(root, item);
    appendAssertionEvent(root, assertion(item)); // durable only — projection has never seen it
    expect(synced(root)).toEqual({ sources: 1, assertions: 1, entities: 2, source_links: 1 });
    const before = assertionProjectionDigest(root);
    // Damage the already-projected event ON DISK. The old sync replayed and
    // strict-parsed the whole corpus per pass and would throw here; the
    // census never rereads a file whose id it already holds — the
    // projection keeps the copy it validated at insert time.
    writeFileSync(join(root, landed.path), "not json\n");
    expect(recoverAssertionProjection(root)).toEqual({ sources: 1, assertions: 1, entities: 2, source_links: 1 });
    expect(assertionProjectionDigest(root)).toBe(before);
    // recovery still picks up a genuinely new event file
    const late = source("ins_followup", "meeting-2");
    late.body = "Ada reported that the sparse-probe run succeeded.";
    appendSourceInsertionEvent(root, late);
    expect(recoverAssertionProjection(root).sources).toBe(2);
  });

  test("a claimed recovery is not repeated by a read; a withdrawn claim is", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-claim-"));
    appendSourceInsertionEvent(root, source());
    expect(synced(root).sources).toBe(1);
    // Another process rebuilt: a generation no read here has recovered.
    const db = new Database(join(root, ".state", "assertions.db"));
    db.run("UPDATE meta SET v = 'gen-from-elsewhere' WHERE k = 'generation'"); db.close();
    const withdraw = claimProjectionRecovery(root); // the viewer's worker has it
    appendSourceInsertionEvent(root, source("ins_by_hand", "meeting-2"));
    expect(synced(root).sources).toBe(1);
    withdraw(); // that worker failed: the next read recovers itself
    expect(synced(root).sources).toBe(2);
  });

  test("a full replay is logically identical to incremental projection", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-assertion-rebuild-"));
    const first = source();
    const second = source("ins_followup", "meeting-2");
    second.body = "Ada reported that the sparse-probe run succeeded.";
    for (const item of [first, second]) {
      appendSourceInsertionEvent(root, item);
      projectSourceInsertion(root, item);
    }
    appendAndProjectAssertion(root, assertion(first));
    const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
    appendAndProjectAssertion(root, createAssertionEvent({
      text: `[[${ada.id}|Ada]] reported that the sparse-probe run succeeded.`, entities: [ada],
      sources: [second.id],
      author: { kind: "user", id: "usr_nick" }, confidence: "direct",
      created_at: "2026-08-18T12:00:00.000Z",
      produced_by: { procedure: "user-assertion", version: "v1" },
    }, new Map([[second.id, second]])));
    const before = assertionProjectionDigest(root);
    expect(rebuildAssertionProjection(root)).toEqual({ sources: 2, assertions: 2, entities: 2, source_links: 2 });
    expect(assertionProjectionDigest(root)).toBe(before);
  });
});
