import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assertionEntityId, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, rebuildAssertionProjection, syncAssertionProjection } from "../lib/assertionProjection";
import { fieldDigest } from "../lib/fieldDigest";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { alias, decline, retract } from "./support/said";
import { insertion, mdVault } from "./support/vault";

const ent = (label: string) => ({ id: assertionEntityId(label), label });
const ada = ent("Ada Lovelace"), atlas = ent("Atlas");
const minutes = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes" });
const agenda = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "agenda" });
const pi = { kind: "model", id: "pi", invocation_id: "mcp" } as const;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function vault(): string {
  const root = mdVault(); roots.push(root);
  for (const s of [minutes, agenda]) appendSourceInsertionEvent(root, s);
  syncAssertionProjection(root);
  return root;
}
function claim(root: string, entities: { id: string; label: string }[], at: string): AssertionEvent {
  const event = createAssertionEvent({
    text: `${entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ")} met.`, entities, sources: [minutes.id],
    author: pi, confidence: "direct", created_at: at, produced_by: { procedure: "bigbrain-mcp", version: "v1" },
  }, new Map([[minutes.id, minutes]]));
  appendAndProjectAssertion(root, event);
  return event;
}

test("the digest is the record's reading, not the projection's state", () => {
  const root = vault();
  claim(root, [ada, atlas], "2026-08-02T12:00:00.000Z");
  const before = fieldDigest(root);
  expect(fieldDigest(root)).toEqual(before);
  rebuildAssertionProjection(root);
  expect(fieldDigest(root)).toEqual(before);
  expect(before.counts).toMatchObject({ assertions: 1, nodes: 4 });
});

test("each reading moves its own part", () => {
  const root = vault();
  const first = claim(root, [ada, atlas], "2026-08-02T12:00:00.000Z");
  claim(root, [ada], "2026-08-03T12:00:00.000Z");
  const was = fieldDigest(root);

  retract(root, first.id);
  const retracted = fieldDigest(root);
  expect(retracted.parts.assertions).not.toBe(was.parts.assertions);
  expect(retracted.parts.graph).not.toBe(was.parts.graph);
  expect(retracted.parts.identity).toBe(was.parts.identity);

  alias(root, "Ada", ada);
  const aliased = fieldDigest(root);
  expect(aliased.parts.identity).not.toBe(retracted.parts.identity);
  expect(aliased.parts.assertions).toBe(retracted.parts.assertions);

  decline(root, [agenda.id]);
  const declined = fieldDigest(root);
  expect(declined.parts.settlement).not.toBe(aliased.parts.settlement);
  expect(declined.parts.identity).toBe(aliased.parts.identity);
  expect(declined.digest).not.toBe(aliased.digest);
});
