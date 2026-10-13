import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInclusionAssertion } from "../lib/assertionLog";
import { appendAndProjectAssertion, rebuildAssertionProjection, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { readLensState } from "../lib/lensRecord";
import { newLens, writeLens } from "../lib/lenses";
import { dueIntakeIds } from "../lib/work";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const note = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes", received_at: "2026-08-02T09:00:00.000Z" });
const said = { created_at: "2026-08-03T00:00:00.000Z", produced_by: { procedure: "test", version: "1" } };
const model = { kind: "model", id: "jev-a", invocation_id: "run-1" } as const;

test("a verdict is a model's score under a rule or a person's word, never both", () => {
  const verdict = { insertion_id: note.id, source_id: "minutes" };
  expect(() => createInclusionAssertion({ lens: "lens_000000000001", rule: "r", verdicts: [{ ...verdict, input: "x", score: .7 }], author: model, ...said })).not.toThrow();
  expect(() => createInclusionAssertion({ lens: "lens_000000000001", verdicts: [{ ...verdict, input: "x", score: .7 }], author: model, ...said }))
    .toThrow("scores name the rule");
  expect(() => createInclusionAssertion({ lens: "lens_000000000001", rule: "r", verdicts: [{ ...verdict, input: "x", score: 1.5 }], author: model, ...said }))
    .toThrow("a score is 0-1");
  expect(() => createInclusionAssertion({ lens: "lens_000000000001", verdicts: [{ ...verdict, include: true, score: .5, input: "x" }], author: model, ...said }))
    .toThrow("a model's score or a person's word");
  expect(() => createInclusionAssertion({ lens: "lens_000000000001", verdicts: [{ ...verdict, include: true }], author: { kind: "user", id: "owner" }, ...said }))
    .toThrow("says how");
  expect(() => createInclusionAssertion({ lens: "not-a-lens", verdicts: [{ ...verdict, include: true, how: "pin" }], author: { kind: "user", id: "owner" }, ...said }))
    .toThrow("invalid lens id");
});

test("an inclusion never settles intake, and a rebuild reads a lens as it was", () => {
  const root = mdVault(); roots.push(root);
  writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
  appendSourceInsertionEvent(root, note, { wake: false });
  syncAssertionProjection(root);
  const lens = newLens({ name: "Example", text: "Example rule" });
  writeLens(root, lens);
  appendAndProjectAssertion(root, createInclusionAssertion({ lens: lens.id, rule: "r",
    verdicts: [{ insertion_id: note.id, source_id: "minutes", input: "x", score: .9 }], author: model, ...said }));
  expect(dueIntakeIds(root)).toEqual([note.id]);
  const before = readLensState(root, lens).members;
  expect([...before.in]).toEqual(["minutes"]);
  rebuildAssertionProjection(root);
  expect(readLensState(root, lens).members).toEqual(before);
});
