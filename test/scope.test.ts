import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, projectNotes, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { vaultRecord, vaultRecordOf, withSnapshot } from "../lib/vaultReadModel";
import { drawGraph, graphOf } from "../lib/views/graph";
import { inLens, liveOf, publishableTo, type Live } from "../lib/views/scope";
import { retract } from "./support/said";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ent = (label: string) => ({ id: assertionEntityId(label), label });
const [ada, atlas, kiln] = [ent("Ada Lovelace"), ent("Atlas"), ent("Kiln")];
const minutes = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes", received_at: "2026-08-02T09:00:00.000Z" });
const diary = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "diary", received_at: "2026-08-02T10:00:00.000Z" });
const stray = insertion({ id: `ins_${"c".repeat(24)}`, source_id: "stray", received_at: "2026-08-02T11:00:00.000Z" });
function vault(): string {
  const root = mdVault(); roots.push(root);
  for (const s of [minutes, diary, stray]) appendSourceInsertionEvent(root, s, { wake: false });
  syncAssertionProjection(root);
  return root;
}
let n = 0;
function claim(root: string, entities: { id: string; label: string }[], cites: SourceInsertion[]): AssertionEvent {
  const event = createAssertionEvent({ text: `${entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ")} met (${++n}).`, entities,
    sources: cites.map((s) => s.id), author: { kind: "user", id: "owner" }, confidence: "direct",
    created_at: `2026-08-03T0${n}:00:00.000Z`, produced_by: { procedure: "test", version: "1" } }, new Map([minutes, diary, stray].map((s) => [s.id, s])));
  appendAndProjectAssertion(root, event);
  return event;
}

test("live is what is not retracted; a lens is what every cited source of is a member; a server likewise", () => {
  const root = vault();
  const both = claim(root, [ada, atlas], [minutes, diary]);
  const one = claim(root, [ada], [minutes]);
  const gone = claim(root, [kiln], [minutes]);
  retract(root, gone.id);
  const live = liveOf(vaultRecord(root));
  expect(live.map((a) => a.id)).toEqual([both.id, one.id]);
  // "all", not "any": the claim that also cites the diary would reveal it
  expect(inLens(live, "work", new Set(["minutes"])).map((a) => a.id)).toEqual([one.id]);
  expect(inLens(live, "work", new Set(["minutes", "diary"])).map((a) => a.id)).toEqual([both.id, one.id]);
  expect(publishableTo(live, "server-1", (ref) => ref.source_id === "minutes").map((a) => a.id)).toEqual([one.id]);
});

test("the whole field's graph is the graph of everything live, as it was", () => {
  const root = vault();
  claim(root, [ada, atlas], [minutes, diary]);
  claim(root, [kiln], [stray]);
  const record = vaultRecord(root);
  expect(withSnapshot(root, (s) => graphOf(s, liveOf(vaultRecordOf(s))))).toEqual(buildAssertionGraph(root, undefined, record));
});

test("a lens draws only its assertions and its members' sources, and no notes", () => {
  const root = vault();
  claim(root, [ada, atlas], [minutes, diary]);
  claim(root, [ada], [minutes]);
  claim(root, [kiln], [stray]);
  mkdirSync(join(root, "memory"));
  writeFileSync(join(root, "memory", "topic.md"), "# Topic\n\nAbout [[Kiln]].\n");
  projectNotes(root, ["memory"]);
  const record = vaultRecord(root);
  const whole = drawGraph(record, liveOf(record));
  expect(whole.nodes.some((node) => node.group === "memory")).toBe(true);
  const lens = drawGraph(record, inLens(liveOf(record), "work", new Set(["minutes"])));
  expect(lens.nodes.map((node) => node.id).toSorted()).toEqual([ada.id, `source:${minutes.id}`].toSorted());
});

test("drawing takes a scope: a record's rows are not one", () => {
  const root = vault();
  const record = vaultRecord(root);
  // @ts-expect-error the rows have not been through liveOf
  const unscoped: Live = record.rows;
  void unscoped;
});
