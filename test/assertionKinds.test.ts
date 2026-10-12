import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  assertionEntityId, createAssertionEvent, createDeclineAssertion, createIdentityAssertion, createRetraction,
  readAssertionLog, readRecordedAssertions, validateRecordedAssertion, type RecordedAssertion,
} from "../lib/assertionLog";
import { aliasEvents, entityAliasResolver } from "../lib/assertionKinds";
import {
  appendAndProjectAssertion, liveAliasDeclarations, liveBindingDeclarations, openAssertionProjectionReadonly,
  projectedAliasTarget, projectionRevision, projectSourceInsertion, rebuildAssertionProjection, recoverAssertionProjection,
} from "../lib/assertionProjection";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { declaredEntitySources, otherCopies, sourceRecord } from "../lib/vaultReadModel";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const person = { kind: "user", id: "owner" } as const;
const model = { kind: "model", id: "judge", invocation_id: "run-1" } as const;
const produced_by = { procedure: "test", version: "1" };
const said = (at: string) => ({ author: person, created_at: `2026-10-12T0${at}:00:00Z`, produced_by });
const entity = (label: string) => ({ id: assertionEntityId(label), label });

function vault() {
  const root = mdVault(); roots.push(root);
  const a = insertion({ id: `ins_${"a".repeat(24)}`, title: "Field notes on the river survey" });
  const b = insertion({ id: `ins_${"b".repeat(24)}`, title: "A second look at the tidal gauges" });
  for (const source of [a, b]) { appendSourceInsertionEvent(root, source); projectSourceInsertion(root, source); }
  return { root, a, b, sources: new Map([[a.id, a], [b.id, b]]) };
}

const live = (root: string, table: string): string[] => {
  const db = openAssertionProjectionReadonly(root);
  try { return (db.query(`SELECT id FROM ${table} WHERE retracted_by IS NULL ORDER BY id`).all() as { id: string }[]).map((r) => r.id); }
  finally { db.close(); }
};

test("prose is written as before: no kind, the same id", () => {
  const { a, sources } = vault();
  const prose = createAssertionEvent({ text: `[[${entity("Ada").id}|Ada]] surveyed the river.`, entities: [entity("Ada")],
    sources: [a.id], confidence: "direct", ...said("1") }, sources);
  expect("kind" in prose).toBe(false);
  expect(prose.id).toMatch(/^ast_[a-f0-9]{24}$/u);
});

test("each kind is held to its own rules", () => {
  const { a, b, sources } = vault();
  const bad = (event: object) => () => validateRecordedAssertion(event as RecordedAssertion);
  const decline = createDeclineAssertion({ reason: "a calendar stub", sources: [a.id], ...said("1") }, sources);
  expect(bad({ ...decline, sources: [] })).toThrow("cites at least one source");
  const retraction = createRetraction({ retracts: decline.id, reason: "filed after all", ...said("2") });
  expect(bad({ ...retraction, retracts: `dec_${"0".repeat(24)}` })).toThrow("invalid retracted id");
  expect(bad({ ...retraction, sources: [] })).toThrow("cites nothing");
  expect(() => createIdentityAssertion({ identity: { says: "same", alias: entity("Ada"), entity: entity("Ada") }, ...said("1") }, sources))
    .toThrow("names another entity");
  expect(() => createIdentityAssertion({ identity: { says: "copy" }, sources: [a.id, b.id], ...said("1"), author: model }, sources))
    .toThrow("carries its score");
  expect(() => createIdentityAssertion({ identity: { says: "not-copy" }, sources: [a.id, b.id], ...said("1"), author: model }, sources))
    .toThrow("by score");
  expect(() => createIdentityAssertion({ identity: { says: "is-source", entity: entity("Survey") }, sources: [a.id, b.id], ...said("1") }, sources))
    .toThrow("one source");
  // a pair is ascending whichever way round it is given
  const copy = createIdentityAssertion({ identity: { says: "copy" }, sources: [b.id, a.id], ...said("1") }, sources);
  expect(copy.sources.map((s) => s.insertion_id)).toEqual([a.id, b.id]);
});

test("a decline settles what it cites; retracting it sends it back", () => {
  const { root, a, sources } = vault();
  const decline = createDeclineAssertion({ reason: "a calendar stub", sources: [a.id], ...said("1") }, sources);
  appendAndProjectAssertion(root, decline);
  expect(sourceRecord(root).declined.has(a.id)).toBe(true);
  appendAndProjectAssertion(root, createRetraction({ retracts: decline.id, reason: "worth filing", ...said("2") }));
  expect(sourceRecord(root).declined.has(a.id)).toBe(false);
});

test("an identity assertion aliases, and a retraction withdraws it", () => {
  const { root, sources } = vault();
  const ada = entity("Ada Lovelace"), short = entity("Ada");
  const same = createIdentityAssertion({ identity: { says: "same", alias: short, entity: ada }, ...said("1") }, sources);
  appendAndProjectAssertion(root, same);
  expect(projectedAliasTarget(root, short.id)).toEqual(ada);
  expect(entityAliasResolver(root)(short)).toEqual(ada);
  appendAndProjectAssertion(root, createRetraction({ retracts: same.id, reason: "two people", ...said("2") }));
  expect(projectedAliasTarget(root, short.id)).toBeUndefined();
  expect(entityAliasResolver(root)(short)).toEqual(short);
  expect(aliasEvents(root).map((e) => e.id)).toEqual([]);
});

test("a retraction a rebuild reads before what it names still withdraws it", () => {
  const { root, a, sources } = vault();
  const ada = entity("Ada Lovelace");
  const same = createIdentityAssertion({ identity: { says: "same", alias: entity("Lovelace"), entity: ada }, ...said("1") }, sources);
  const bound = createIdentityAssertion({ identity: { says: "is-source", entity: ada }, sources: [a.id], ...said("2") }, sources);
  // a rebuild reads a month's assertions in id order: retractions whose ids
  // sort before what they name land first
  const first = (retracts: string) => {
    for (let n = 0; ; n++) {
      const retraction = createRetraction({ retracts, reason: `not so (${n})`, ...said("3") });
      if (retraction.id < retracts) return retraction;
    }
  };
  for (const target of [same, bound]) {
    appendAndProjectAssertion(root, target);
    appendAndProjectAssertion(root, first(target.id));
  }
  const before = { aliases: live(root, "entity_alias_events"), bindings: live(root, "entity_source_events") };
  expect(before).toEqual({ aliases: [], bindings: [] });
  rebuildAssertionProjection(root);
  expect({ aliases: live(root, "entity_alias_events"), bindings: live(root, "entity_source_events") }).toEqual(before);
  expect(projectedAliasTarget(root, entity("Lovelace").id)).toBeUndefined();
  // and the census holds every kind: recovery finds nothing to do
  const revision = projectionRevision(root);
  recoverAssertionProjection(root);
  expect(projectionRevision(root)).toBe(revision);
});

test("a person's copy and not-copy fold as declarations did: the latest stands", () => {
  const { root, a, b, sources } = vault();
  appendAndProjectAssertion(root, createIdentityAssertion({ identity: { says: "copy" }, sources: [a.id, b.id], ...said("1") }, sources));
  expect(otherCopies(root, a.id).map((c) => c.id)).toEqual([b.id]);
  appendAndProjectAssertion(root, createIdentityAssertion({ identity: { says: "not-copy" }, sources: [a.id, b.id], ...said("2") }, sources));
  expect(otherCopies(root, a.id)).toEqual([]);
});

test("retracting prose withdraws it as a revocation does, and the log reader keeps live prose only", () => {
  const { root, a, sources } = vault();
  const ada = entity("Ada");
  const prose = createAssertionEvent({ text: `[[${ada.id}|Ada]] surveyed the river.`, entities: [ada],
    sources: [a.id], confidence: "direct", ...said("1") }, sources);
  appendAndProjectAssertion(root, prose);
  appendAndProjectAssertion(root, createDeclineAssertion({ reason: "nothing else here", sources: [a.id], ...said("2") }, sources));
  expect(readAssertionLog(root).map((e) => e.id)).toEqual([prose.id]);
  appendAndProjectAssertion(root, createRetraction({ retracts: prose.id, reason: "wrong river", ...said("3") }));
  expect(readAssertionLog(root)).toEqual([]);
  expect(readRecordedAssertions(root).map((e) => e.kind ?? "prose").sort()).toEqual(["decline", "prose", "retraction"]);
  const db = openAssertionProjectionReadonly(root);
  try { expect(db.query("SELECT revoked_by IS NOT NULL AS gone FROM assertions WHERE id = ?").get(prose.id)).toEqual({ gone: 1 }); }
  finally { db.close(); }
});

test("what an alias or a binding retraction withdraws: every standing declaration", () => {
  const { root, a, sources } = vault();
  const ada = entity("Ada Lovelace"), short = entity("Ada");
  const old = createIdentityAssertion({ identity: { says: "same", alias: short, entity: entity("Ada King") }, ...said("1") }, sources);
  appendAndProjectAssertion(root, old);
  const same = createIdentityAssertion({ identity: { says: "same", alias: short, entity: ada }, ...said("2") }, sources);
  appendAndProjectAssertion(root, same);
  expect(liveAliasDeclarations(root, short.id)).toEqual([same.id, old.id].sort());
  for (const retracts of liveAliasDeclarations(root, short.id))
    appendAndProjectAssertion(root, createRetraction({ retracts, reason: "its own entity", ...said("3") }));
  expect(projectedAliasTarget(root, short.id)).toBeUndefined();

  // a binding made under an alias is the canonical's to unbind
  appendAndProjectAssertion(root, createIdentityAssertion({ identity: { says: "same", alias: entity("Lovelace"), entity: ada }, ...said("4") }, sources));
  const oldBinding = createIdentityAssertion({ identity: { says: "is-source", entity: entity("Lovelace") }, sources: [a.id], ...said("5") }, sources);
  appendAndProjectAssertion(root, oldBinding);
  const binding = createIdentityAssertion({ identity: { says: "is-source", entity: ada }, sources: [a.id], ...said("6") }, sources);
  appendAndProjectAssertion(root, binding);
  expect(liveBindingDeclarations(root, ada.id, a.id)).toEqual([binding.id, oldBinding.id].sort());
  for (const retracts of liveBindingDeclarations(root, ada.id, a.id))
    appendAndProjectAssertion(root, createRetraction({ retracts, reason: "not this source", ...said("7") }));
  expect(live(root, "entity_source_events")).toEqual([]);
  // still decided: the bulk pass never binds the pair again
  expect(declaredEntitySources(root).map((e) => e.id).sort()).toEqual([binding.id, oldBinding.id].sort());
});
