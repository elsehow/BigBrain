import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, recoverAssertionProjection, syncAssertionProjection } from "../lib/assertionProjection";
import { appendSourceInsertionEvent, insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { withSnapshot } from "../lib/vaultReadModel";
import { readEntitySources, readLensClaims } from "../lib/views/v2Read";
import { insertion, mdVault } from "./support/vault";
import { alias, retract } from "./support/said";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const atlas = { id: assertionEntityId("Atlas"), label: "Atlas" };
const short = { id: assertionEntityId("Atlas project"), label: "Atlas project" };
const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T12:00:00Z`;
const source = (n: number, received = n) => insertion({ id: `ins_${n.toString(16).padStart(24, "0")}`, source_id: `sample-${n}`,
  title: `Sample ${n}`, received_at: day(received), occurred_at: day(30 - n), envelope: { source: "web" } });
function vault(sources: SourceInsertion[]) {
  const root = mdVault(); roots.push(root);
  for (const s of sources) appendSourceInsertionEvent(root, s);
  syncAssertionProjection(root);
  return root;
}
function claim(root: string, sources: SourceInsertion[], at = day(20), entity = atlas) {
  const event = createAssertionEvent({ text: `[[${entity.id}|${entity.label}]] appears in these sources at ${at}.`, entities: [entity],
    sources: sources.map(s => s.id), created_at: at, confidence: "direct", author: { kind: "user", id: "tester" },
    produced_by: { procedure: "test", version: "1" } }, new Map(sources.map(s => [s.id, s])));
  appendAndProjectAssertion(root, event);
  return event;
}
const read = (root: string, id = atlas.id) => withSnapshot(root, s => readEntitySources(s, id));

test("all cited sources are unique and newest-added first, independent of publication and claim dates", () => {
  const sources = Array.from({ length: 9 }, (_, i) => source(i + 1));
  const root = vault(sources);
  for (const [i, s] of sources.entries()) claim(root, [s], day(29 - i));
  claim(root, [sources[0]!, sources[8]!], day(30));
  expect(read(root).map(s => s.id)).toEqual(sources.toReversed().map(s => s.id));
  expect(read(root)[0]).toEqual({ id: sources[8]!.id, path: insertionEventRel(sources[8]!), title: "Sample 9", added: day(9), via: "web" });
});

test("aliases share sources; retracted or unrelated claims do not contribute", () => {
  const [a, b, c] = [source(1), source(2), source(3)];
  const root = vault([a!, b!, c!]);
  alias(root, short.label, atlas);
  claim(root, [a!], day(20), short);
  const gone = claim(root, [b!]);
  claim(root, [c!], day(21), { id: assertionEntityId("Orrery"), label: "Orrery" });
  retract(root, gone.id);
  expect(read(root).map(s => s.id)).toEqual([a!.id]);
  expect(read(root, short.id)).toEqual(read(root));
});

test("removed and superseded sources stay out, including mixed live citations", () => {
  const old = source(1), kept = source(2), missing = source(3);
  const replacement = { ...source(4), source_id: old.source_id, envelope: { supersedes: old.id } };
  const root = vault([old, kept, missing, replacement]);
  claim(root, [old, kept]); claim(root, [missing]); claim(root, [replacement]);
  rmSync(join(root, insertionEventRel(missing)));
  recoverAssertionProjection(root);
  expect(read(root).map(s => s.id)).toEqual([replacement.id, kept.id]);
});

test("lens sources come only from claims wholly supported by its members", () => {
  const inside = source(1), outside = source(2), mixed = source(3);
  const root = vault([inside, outside, mixed]);
  claim(root, [inside]); claim(root, [mixed, outside]);
  const rows = withSnapshot(root, snapshot => readEntitySources(snapshot, atlas.id,
    readLensClaims(snapshot, [inside.source_id, mixed.source_id])));
  expect(rows.map(s => s.id)).toEqual([inside.id]);
  expect(withSnapshot(root, snapshot => readEntitySources(snapshot, atlas.id, new Set()))).toEqual([]);
});
