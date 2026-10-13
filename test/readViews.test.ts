import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, projectNotes, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { memoryRead, notePayload } from "../lib/noteRead";
import { readLedger } from "../lib/retrieval";
import { recordScan, scanSurface } from "../lib/searchCore";
import { withSnapshot } from "../lib/vaultReadModel";
import { noteHistoryOf } from "../lib/views/noteHistory";
import { decline, retract } from "./support/said";
import { insertion, mdVault } from "./support/vault";

// R6 (docs/plans/2026-10-12-stages-and-views-refactor.md): note, search and
// agent reads come from the projection, never the disk; the retrieval ledger
// is written by the door that served a read, never by the read.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const minutes = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes", title: "Orchard minutes", received_at: "2026-08-02T09:00:00.000Z",
  author: { kind: "user", id: "owner" } });
const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
function vault(): string {
  const root = mdVault(); roots.push(root);
  appendSourceInsertionEvent(root, minutes, { wake: false });
  syncAssertionProjection(root);
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory", "MEMORY.md"), "# Memory\n\nThe orchard is planted.\n");
  projectNotes(root, ["memory"]);
  return root;
}
const claim = (root: string, at: string) => {
  const event = createAssertionEvent({ text: `[[${ada.id}|Ada Lovelace]] planned the orchard (${at}).`, entities: [ada], sources: [minutes.id],
    author: { kind: "model", id: "pi", invocation_id: "run-1" }, confidence: "direct", created_at: at,
    produced_by: { procedure: "bigbrain-mcp", version: "v1" } }, new Map([[minutes.id, minutes]]));
  appendAndProjectAssertion(root, event);
  return event;
};

test("memory and notes are read as the notes door projected them: a file gone from disk is still the record's until the census sees it", () => {
  const root = vault();
  rmSync(join(root, "memory", "MEMORY.md"));
  expect(memoryRead(root)).toEqual({ status: 200, text: "# Memory\n\nThe orchard is planted.\n" });
  expect(notePayload(root, "memory/MEMORY.md")).toMatchObject({ status: 200 });
  projectNotes(root, ["memory"]);
  expect(memoryRead(root).status).toBe(404);
});

test("a search writes nothing; its door writes the ledger", () => {
  const root = vault();
  claim(root, "2026-08-03T10:00:00.000Z");
  const r = scanSurface(root, "orchard", 10, "web");
  if (!r.ok) throw new Error(r.reason);
  expect(r.hits.length).toBeGreaterThan(0);
  expect(readLedger(root)).toEqual([]);
  recordScan(root, "orchard", r, "web");
  expect(readLedger(root).map((row) => row.t)).toEqual(["search"]);
});

test("a note's history is what the record says touched it, newest first", () => {
  const root = vault();
  const first = claim(root, "2026-08-03T10:00:00.000Z");
  claim(root, "2026-08-04T10:00:00.000Z");
  retract(root, first.id, { created_at: "2026-08-05T10:00:00.000Z" });
  decline(root, [minutes.id], "nothing more", { created_at: "2026-08-06T10:00:00.000Z" });
  const history = withSnapshot(root, (s) => noteHistoryOf(s, insertionEventRel(minutes)))!;
  expect(history.map((r) => [new Date(r.at).toISOString().slice(0, 10), r.actor, r.action])).toEqual([
    ["2026-08-06", "owner", "declined"],
    ["2026-08-05", "owner", "retracted a claim"],
    ["2026-08-04", "pi", "asserted"],
    ["2026-08-03", "pi", "asserted"],
    ["2026-08-02", "owner", "landed"],
  ]);
  const entity = withSnapshot(root, (s) => noteHistoryOf(s, `projection/entities/${ada.id}.md`))!;
  expect(entity.map((r) => r.action)).toEqual(["asserted"]); // the retracted claim left the entity's edges
  expect(withSnapshot(root, (s) => noteHistoryOf(s, "memory/MEMORY.md"))).toBeUndefined();
});
