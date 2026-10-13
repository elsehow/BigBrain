import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { forgetGraphView, graphDeltaSince, graphNow, graphStamp, maintainGraphView, savedGraph } from "../lib/maintainedGraph";
import { applyGraphDelta, diffGraph } from "../lib/views/graphDelta";
import { insertion, mdVault } from "./support/vault";

// Step 8: a viewer holding the last picture is sent what changed.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { forgetGraphView(root); rmSync(root, { recursive: true, force: true }); } });
const ent = (label: string) => ({ id: assertionEntityId(label), label });
let n = 0;
function claim(root: string, labels: string[], source: SourceInsertion): void {
  const entities = labels.map(ent);
  appendAndProjectAssertion(root, createAssertionEvent({ text: `${entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ")} met (${++n}).`,
    entities, sources: [source.id], author: { kind: "user", id: "owner" }, confidence: "direct",
    created_at: `2026-08-${String(2 + n).padStart(2, "0")}T10:00:00.000Z`, produced_by: { procedure: "test", version: "1" } }, new Map([[source.id, source]])));
}

test("a commit's delta is what it touched, and applying it draws the new picture exactly", async () => {
  const root = mdVault(); roots.push(root);
  const sources = Array.from({ length: 12 }, (_, i) => insertion({ id: `ins_${String(i).padStart(24, "a")}`, source_id: `note-${i}`, title: `Note ${i}`,
    received_at: `2026-08-01T0${i % 10}:00:00.000Z` }));
  for (const s of sources) appendSourceInsertionEvent(root, s, { wake: false });
  syncAssertionProjection(root);
  for (let i = 0; i < 10; i++) claim(root, [`Person ${i % 4}`, `Place ${i % 3}`], sources[i]!);
  const before = graphNow(root), stamp = graphStamp(root);
  claim(root, ["Person 1", "Orchard"], sources[10]!);
  await maintainGraphView(root);
  const after = savedGraph(root)!;
  const delta = graphDeltaSince(root, stamp)!;
  expect(delta).toMatchObject({ from: stamp, to: graphStamp(root), base: before.hash, hash: after.hash });
  expect(delta.removed).toEqual([]);
  // the new source's node, the new entity, and Person 1's degree: not the field
  expect(delta.nodes.length).toBeLessThan(after.nodes.length / 2);
  expect(applyGraphDelta(before, delta)).toEqual(after);
  expect(applyGraphDelta(before, diffGraph(before, after))).toEqual(after);
  expect(graphDeltaSince(root, "a-picture-no-one-kept")).toBeUndefined();
  expect(() => applyGraphDelta(after, delta)).toThrow("not the picture");
});
