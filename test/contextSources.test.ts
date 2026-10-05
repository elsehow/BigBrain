import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { withContextSources } from "../lib/contextSources";
import { appendSourceInsertionEvent, insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { appendRevocationEvent, createRevocationEvent } from "../lib/revocationLog";
import { insertion } from "./support/vault";

// an invented vault: a field report naming Ada and the Orrery, one claim
// about Briar that was taken back, and a drop the gardener hasn't reached
const root = mkdtempSync(join(tmpdir(), "bb-context-sources-"));
const source = (id: string, title: string): SourceInsertion =>
  insertion({ id, source_id: `ref-${id}`, title, body: "Ada repaired the orrery with Briar.", envelope: {} });
const report = source("ins-report", "Field report"), drop = source("ins-drop", "Unread drop");
appendSourceInsertionEvent(root, report);
appendSourceInsertionEvent(root, drop);
const entity = (label: string) => ({ id: assertionEntityId(label), label });
const ada = entity("Ada Lovelace"), orrery = entity("Orrery"), briar = entity("Briar Lowe");
const claim = (text: string, entities: typeof ada[], at: string) => {
  const event = createAssertionEvent({ text, entities, citations: [{ insertion_id: report.id, quotes: [report.body] }],
    author: { kind: "model", id: "test-model", invocation_id: "run-1" }, confidence: "direct", created_at: at,
    produced_by: { procedure: "test", version: "v1" } }, new Map([[report.id, report]]));
  appendAssertionEvent(root, event);
  return event;
};
claim(`[[${ada.id}|Ada]] repaired the [[${orrery.id}|orrery]].`, [ada, orrery], "2026-10-01T09:00:00.000Z");
const wrong = claim(`[[${briar.id}|Briar]] repaired the orrery.`, [briar], "2026-10-01T09:01:00.000Z");
appendRevocationEvent(root, createRevocationEvent({ assertion_id: wrong.id, reason: "misread", author: { kind: "model", id: "test-model", invocation_id: "run-2" },
  created_at: "2026-10-01T09:02:00.000Z", produced_by: { procedure: "test", version: "v1" } }));
const graph = buildAssertionGraph(root);

test("a source in a Desktop's context carries the entities its live claims mention", () => {
  const nodes = withContextSources({ context: [`source:${report.id}`] }, graph).contextNodes!;
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({ id: `source:${report.id}`, path: insertionEventRel(report), title: "Field report", group: "source" });
  // Briar's claim was revoked: it no longer says the report concerns her
  expect([...nodes[0]!.entities!].sort()).toEqual([ada.id, orrery.id].sort());
});

test("a source given by its note path is found the same way", () => {
  const given = { id: insertionEventRel(report), path: insertionEventRel(report), title: "Field report" };
  const [node] = withContextSources({ contextNodes: [given] }, graph).contextNodes!;
  expect([...node!.entities!].sort()).toEqual([ada.id, orrery.id].sort());
});

test("a source the gardener hasn't filed yet concerns nothing yet", () => {
  expect(withContextSources({ context: [`source:${drop.id}`] }, graph).contextNodes).toEqual([
    { id: `source:${drop.id}`, path: insertionEventRel(drop), title: "Unread drop", group: "source", entities: [] }]);
});

test("entities and notes in context are left as they were", () => {
  const desk = { context: [ada.id], contextNodes: [{ id: "memory/notes.md", path: "memory/notes.md", title: "Notes", group: "memory" }] };
  expect(withContextSources(desk, graph)).toBe(desk);
});
