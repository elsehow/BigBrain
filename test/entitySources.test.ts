import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityId, createAssertionEvent, type AssertionEntity } from "../lib/assertionLog";
import { appendAndProjectAssertion, appendAndProjectEntityAlias, appendAndProjectEntitySource, syncAssertionProjection } from "../lib/assertionProjection";
import { createEntityAliasEvent } from "../lib/entityAliasLog";
import { createEntitySourceEvent, latestEntitySourceDeclarations, readEntitySourceLog } from "../lib/entitySourceLog";
import { sourceMatch } from "../lib/entitySourceMatch";
import { planEntitySourceSeed, seedEntitySources } from "../lib/entitySourceSeed";
import type { SourceInsertion } from "../lib/insertionLog";
import { submitWire } from "../lib/work";
import { insertion, nativeVault } from "./support/vault";

const PAPER = "Tidal Lanterns in Coastal Navigation: A Field Survey";
const AUTHOR = { kind: "user" as const, id: "owner@example.com" };
const MODEL = { kind: "model" as const, id: "test-model", invocation_id: "run-1" };
const PRODUCED = { procedure: "test", version: "1" };
const ent = (label: string): AssertionEntity => ({ id: assertionEntityId(label), label });

const paper = insertion({ id: `ins_${"a".repeat(24)}`, title: PAPER, body: `${PAPER}\n\nWe surveyed lantern use across forty harbours.`, envelope: { kind: "document" } });
const notes = insertion({ id: `ins_${"b".repeat(24)}`, title: "Harbour project notes", body: "Mara wants the lantern survey for the Harbour project." });
const roots: string[] = [];
const vault = (insertions: SourceInsertion[] = [paper, notes]) => {
  const root = nativeVault({ prefix: "bb-entity-sources-", insertions });
  roots.push(root);
  syncAssertionProjection(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A claim written straight to the log, the way history holds one — no
 * submit, so no binding on extraction. */
function claim(root: string, entities: AssertionEntity[], source: SourceInsertion, at: string): void {
  appendAndProjectAssertion(root, createAssertionEvent({
    text: entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ") + " were discussed.",
    entities, sources: [source.id], author: MODEL, confidence: "direct", created_at: at, produced_by: PRODUCED,
  }, new Map([[source.id, source]])));
}

describe("sourceMatch", () => {
  test("a label that is the title, or the title without its subtitle, names the source", () => {
    expect(sourceMatch(PAPER, { title: PAPER })).toBe("title");
    expect(sourceMatch("tidal lanterns in coastal navigation — a field survey", { title: PAPER })).toBe("title");
    expect(sourceMatch("Tidal Lanterns in Coastal Navigation", { title: PAPER })).toBe("title");
    expect(sourceMatch(PAPER, { title: `${PAPER} (Okafor et al., 2026).pdf` })).toBe("title");
    expect(sourceMatch(PAPER, { title: `${PAPER} | Journal of Harbours` })).toBe("title");
  });

  test("a short name never binds: a thing with a site is not its page", () => {
    expect(sourceMatch("Lanternworks", { title: "Lanternworks" })).toBeUndefined();
    expect(sourceMatch("Harbour project", { title: "Harbour project" })).toBeUndefined();
    expect(sourceMatch("Tidal Lanterns", { title: PAPER })).toBeUndefined();
  });

  test("a short title binds only on a work; talk and encyclopedia pages never bind", () => {
    expect(sourceMatch("The Quiet Harbour", { title: "The Quiet Harbour", kind: "web-clip" })).toBe("title");
    expect(sourceMatch("The Quiet Harbour", { title: "The Quiet Harbour", kind: "note" })).toBeUndefined();
    expect(sourceMatch(PAPER, { title: PAPER, kind: "note" })).toBe("title");
    expect(sourceMatch("Dana building manager", { title: "Dana building manager", kind: "meeting" })).toBeUndefined();
    expect(sourceMatch(PAPER, { title: PAPER, kind: "email" })).toBeUndefined();
    expect(sourceMatch("Lantern beauty contest", { title: "Lantern beauty contest - Wikipedia", kind: "web-clip" })).toBeUndefined();
  });

  test("a paper whose body opens with the label names it; one that mentions it in passing is only near", () => {
    expect(sourceMatch(PAPER, { title: "scan_0042.pdf", head: `# ${PAPER}\nAbstract` })).toBe("head");
    expect(sourceMatch(PAPER, { title: `Notes on ${PAPER}` })).toBe("near");
    expect(sourceMatch(PAPER, { title: "Reading list", head: `This week: ${PAPER}, then more.` })).toBe("near");
  });
});

describe("entity source log", () => {
  test("the latest declaration per pair wins, so an unbind sticks until a later bind", () => {
    const e = ent(PAPER);
    const at = (t: string, bound: boolean) => createEntitySourceEvent({
      entity: e, insertion_id: paper.id, bound, author: AUTHOR, created_at: t, produced_by: PRODUCED,
    });
    const events = [at("2026-10-01T00:00:00Z", true), at("2026-10-02T00:00:00Z", false)];
    expect(latestEntitySourceDeclarations(events).map((x) => x.bound)).toEqual([false]);
    expect(latestEntitySourceDeclarations([...events, at("2026-10-03T00:00:00Z", true)]).map((x) => x.bound)).toEqual([true]);
    expect(() => createEntitySourceEvent({ entity: { id: "nope", label: PAPER }, insertion_id: paper.id, bound: true, author: AUTHOR, created_at: "t", produced_by: PRODUCED }))
      .toThrow("invalid entity");
  });
});

describe("binding on extraction", () => {
  const opts = { author: { kind: "agent" as const, id: "test" }, produced_by: PRODUCED };
  const item = (text: string, source: SourceInsertion) => ({ submit: "assertion", text, sources: [source.id], confidence: "direct" });

  test("an entity minted from the document it names is bound to it, and the graph draws the pair as one", () => {
    const root = vault();
    const result = submitWire(root, [
      item(`[[${PAPER}]] found lanterns in most of the harbours surveyed.`, paper),
      item("[[Mara Okafor]] wants the survey for [[Harbour Project Atlas]].", notes),
    ], opts);
    expect(result.appended).toBe(2);
    expect(readEntitySourceLog(root).map((e) => [e.entity.label, e.insertion_id, e.bound, e.author.kind])).toEqual([
      [PAPER, paper.id, true, "system"],
    ]);

    const graph = buildAssertionGraph(root);
    const entity = graph.nodes.find((n) => n.title === PAPER)!;
    expect(entity.opens).toEqual([`source:${paper.id}`]);
    expect(graph.nodes.find((n) => n.id === `source:${paper.id}`)?.drawnAs).toBe(entity.id);
    // the source stays in the projection for every other reader
    expect(graph.nodes.find((n) => n.id === `source:${notes.id}`)?.drawnAs).toBeUndefined();
    expect(graph.nodes.find((n) => n.title === "Mara Okafor")?.opens).toBeUndefined();
  });

  test("an entity the record already held is not re-decided by a later claim", () => {
    const root = vault();
    submitWire(root, [item(`[[${PAPER}]] was mentioned in passing.`, notes)], opts);
    submitWire(root, [item(`[[${ent(PAPER).id}|${PAPER}]] found lanterns in most harbours.`, paper)], opts);
    expect(readEntitySourceLog(root)).toEqual([]);
  });
});

describe("bind-sources backfill", () => {
  test("binds an entity first and mostly claimed from the source it names, once", () => {
    const root = vault();
    claim(root, [ent(PAPER)], paper, "2026-10-01T00:00:00.000Z");
    claim(root, [ent(PAPER), ent("Mara Okafor")], paper, "2026-10-01T00:01:00.000Z");
    claim(root, [ent(PAPER), ent("Harbour Project Atlas")], notes, "2026-10-01T00:02:00.000Z");

    const dry = seedEntitySources(root, { author: AUTHOR, dryRun: true });
    expect(dry.appended).toBe(0);
    expect(dry.bind.map((b) => [b.entity.label, b.insertion_id, b.match, b.citing, b.claims])).toEqual([[PAPER, paper.id, "title", 2, 3]]);
    expect(readEntitySourceLog(root)).toEqual([]);

    expect(seedEntitySources(root, { author: AUTHOR }).appended).toBe(1);
    expect(buildAssertionGraph(root).nodes.find((n) => n.title === PAPER)?.opens).toEqual([`source:${paper.id}`]);
    expect(seedEntitySources(root, { author: AUTHOR }).appended).toBe(0);
  });

  test("a paper landed twice binds to both landings, the claims on either counting for it", () => {
    const again = insertion({ id: `ins_${"c".repeat(24)}`, title: `${PAPER}.pdf`, body: "Forty harbours, again.", envelope: { kind: "pdf-import" } });
    const root = vault([paper, notes, again]);
    claim(root, [ent(PAPER)], paper, "2026-10-01T00:00:00.000Z");
    claim(root, [ent(PAPER)], again, "2026-10-01T00:01:00.000Z");
    claim(root, [ent(PAPER), ent("Harbour Project Atlas")], notes, "2026-10-01T00:02:00.000Z");
    const plan = planEntitySourceSeed(root);
    expect(plan.bind.map((b) => [b.insertion_id, b.citing, b.claims])).toEqual([[paper.id, 2, 3], [again.id, 2, 3]]);
    expect(plan.unclear).toEqual([]);
  });

  test("an entity first claimed from elsewhere is unclear, never bound", () => {
    const root = vault();
    claim(root, [ent(PAPER)], notes, "2026-10-01T00:00:00.000Z");
    claim(root, [ent(PAPER)], paper, "2026-10-01T00:01:00.000Z");
    const plan = planEntitySourceSeed(root);
    expect(plan.bind).toEqual([]);
    expect(plan.unclear.map((u) => [u.entity.label, u.reason])).toEqual([[PAPER, "its first claim cites another source"]]);
  });

  test("a person's unbind is a decision the backfill leaves alone", () => {
    const root = vault();
    claim(root, [ent(PAPER)], paper, "2026-10-01T00:00:00.000Z");
    appendAndProjectEntitySource(root, createEntitySourceEvent({
      entity: ent(PAPER), insertion_id: paper.id, bound: false, author: AUTHOR, created_at: "2026-10-02T00:00:00.000Z", produced_by: PRODUCED,
    }));
    expect(planEntitySourceSeed(root).bind).toEqual([]);
    expect(buildAssertionGraph(root).nodes.find((n) => n.title === PAPER)?.opens).toBeUndefined();
  });

  test("a binding holds for the entity a label was folded into", () => {
    const root = vault();
    const short = ent("Tidal Lanterns in Coastal Navigation");
    claim(root, [short], paper, "2026-10-01T00:00:00.000Z");
    claim(root, [ent("Lantern survey")], notes, "2026-10-01T00:01:00.000Z");
    expect(seedEntitySources(root, { author: AUTHOR }).appended).toBe(1);
    appendAndProjectEntityAlias(root, createEntityAliasEvent({
      alias: short.label, entity: ent("Lantern survey"), author: AUTHOR, created_at: "2026-10-03T00:00:00.000Z", produced_by: PRODUCED,
    }));
    const graph = buildAssertionGraph(root);
    expect(graph.nodes.find((n) => n.title === "Lantern survey")?.opens).toEqual([`source:${paper.id}`]);
  });
});
