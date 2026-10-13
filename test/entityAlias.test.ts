/** entityAlias.test.ts — one label names another entity (lib/entityAliasLog.ts).
 *
 * The invariants: an alias event folds by latest-wins / retract / flatten /
 * drop-the-oldest-in-a-cycle; the projection answers every entity read
 * through the table and a rebuild reproduces it; intake canonicalizes both
 * link forms to the canonical id and refuses to mint a one-word label an
 * existing entity carries; the entity view and graph draw one entity; the
 * legacy dossiers seed the table conservatively and idempotently.
 */
import { describe, expect, test } from "bun:test";
import { projectedLabelRows } from "../lib/assertionProjection";
import { lookalikeRefusal } from "../lib/assertionAgent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeAssertionLinks } from "../lib/assertionAgent";
import { assertionEntityPath, assertionEntityView, assertionEntityMarkdown } from "../lib/assertionEntityView";
import { buildAssertionGraph } from "../lib/assertionGraph";
import {
  appendAssertionEvent, assertionEntityId, createAssertionEvent, createIdentityAssertion, sameAs, type AssertionEntity,
} from "../lib/assertionLog";
import {
  appendAndProjectAssertion,
  openAssertionProjectionReadonly,
  assertionProjectionDigest,
  assertionProjectionStats,
  assertionsWithRefsForEntity,
  projectSourceInsertion,
  projectedAssertionEntity,
  projectedEntityCandidates,
  rebuildAssertionProjection,
  searchAssertionEntities,
  syncAssertionProjection,
} from "../lib/assertionProjection";
import {
  appendEntityAliasEvent,
  createEntityAliasEvent,
  entityAliasResolution,
  readEntityAliasLog,
  validateEntityAliasEvent,
  type EntityAliasEvent,
} from "../lib/entityAliasLog";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { alias, retract } from "./support/said";
import { insertion } from "./support/vault";

const AUTHOR = { kind: "user", id: "nick" } as const;
const PRODUCED = { procedure: "test", version: "v1" } as const;

const ent = (label: string): AssertionEntity => ({ id: assertionEntityId(label), label });
const EK = ent("Evan Keller");
const EVAN = ent("Evan");
const JULES = ent("Jules Lane");

let tick = 0;
const stamp = (): string => `2026-08-20T10:${String(tick++).padStart(2, "0")}:00.000Z`;

/** A vault with one source and the given assertions, each `[[label]]`
 * minted DIRECTLY (bypassing intake's guard — the record as it stood). */
function vault(...texts: string[]): { root: string; ins: SourceInsertion } {
  const root = mkdtempSync(join(tmpdir(), "bb-alias-"));
  const ins = insertion({ id: "ins_alias0000000000000000a", body: "Evan and Jules talked.", occurred_at: "2026-08-18T10:00:00.000Z" });
  appendSourceInsertionEvent(root, ins);
  projectSourceInsertion(root, ins);
  for (const text of texts) {
    const entities: AssertionEntity[] = [];
    const linked = text.replace(/\[\[([^\]|]+)\]\]/g, (_all, label: string) => {
      const e = ent(label);
      if (!entities.some((held) => held.id === e.id)) entities.push(e);
      return `[[${e.id}|${label}]]`;
    });
    appendAndProjectAssertion(root, createAssertionEvent({
      text: linked, entities, sources: [ins.id], author: { kind: "model", id: "m", invocation_id: "r" },
      confidence: "direct", created_at: stamp(), produced_by: PRODUCED,
    }, new Map([[ins.id, ins]])));
  }
  return { root, ins };
}

const aliasEvent = (label: string, entity: AssertionEntity, created_at = stamp()): EntityAliasEvent =>
  createEntityAliasEvent({ alias: label, entity, author: AUTHOR, created_at, produced_by: PRODUCED });

describe("the alias log", () => {
  test("an event round-trips, validates its own hash, and a self-alias is a retraction", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-alias-log-"));
    const event = aliasEvent("Evan", EK);
    expect(event.alias_id).toBe(EVAN.id);
    expect(appendEntityAliasEvent(root, event).deduped).toBe(false);
    expect(appendEntityAliasEvent(root, event).deduped).toBe(true);
    expect(readEntityAliasLog(root, { strict: true })).toEqual([event]);
    expect(() => validateEntityAliasEvent({ ...event, alias_id: JULES.id })).toThrow("does not hash");
    expect(() => validateEntityAliasEvent({ ...event, alias: " Evan" })).toThrow("whitespace");
    const { canonical } = entityAliasResolution([event, aliasEvent("Evan", EVAN)]);
    expect(canonical.size).toBe(0);
  });

  test("the fold: latest wins, chains flatten, a cycle drops its oldest declaration", () => {
    const A = ent("A"), B = ent("B"), C = ent("C");
    // latest wins
    let r = entityAliasResolution([aliasEvent("A", B, "2026-01-01T00:00:00Z"), aliasEvent("A", C, "2026-01-02T00:00:00Z")]);
    expect(r.canonical.get(A.id)).toEqual(C);
    // chain A→B, B→C flattens to A→C, and C carries both labels
    r = entityAliasResolution([aliasEvent("A", B), aliasEvent("B", C)]);
    expect(r.canonical.get(A.id)).toEqual(C);
    expect(r.canonical.get(B.id)).toEqual(C);
    expect(r.labels.get(C.id)).toEqual(["A", "B"]);
    // cycle B→C (t1), C→A (t2), A→B (t3): the oldest (B→C) yields; C→A→B
    r = entityAliasResolution([
      aliasEvent("B", C, "2026-01-01T00:00:00Z"), aliasEvent("C", A, "2026-01-02T00:00:00Z"), aliasEvent("A", B, "2026-01-03T00:00:00Z"),
    ]);
    expect(r.canonical.get(A.id)).toEqual(B);
    expect(r.canonical.get(C.id)).toEqual(B);
    expect(r.canonical.has(B.id)).toBe(false);
  });
});

describe("the projection resolves through the table", () => {
  test("declared after the split: one entity, merged count, both labels searchable, rebuild agrees", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello to [[Jules Lane]].");
    expect(searchAssertionEntities(root, "Evan").map((h) => h.label).sort()).toEqual(["Evan", "Evan Keller"]);
    expect(assertionProjectionStats(root).entities).toBe(3);

    alias(root, "Evan", EK);

    expect(projectedAssertionEntity(root, EVAN.id)).toEqual({ id: EK.id, label: "Evan Keller", assertions: 2, aliases: ["Evan"] });
    expect(projectedAssertionEntity(root, EK.id)?.assertions).toBe(2);
    const hits = searchAssertionEntities(root, "Evan");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: EK.id, label: "Evan Keller", assertions: 2 });
    expect(searchAssertionEntities(root, "Keller")[0]?.assertions).toBe(2);
    expect(assertionsWithRefsForEntity(root, EK.id, 10)).toHaveLength(2);
    expect(assertionsWithRefsForEntity(root, EVAN.id, 10)).toHaveLength(2);
    expect(assertionProjectionStats(root).entities).toBe(2);

    const before = assertionProjectionDigest(root);
    rebuildAssertionProjection(root);
    expect(assertionProjectionDigest(root)).toBe(before);
    expect(projectedAssertionEntity(root, EVAN.id)?.id).toBe(EK.id);
  });

  test("a retraction restores the stub; a re-declaration moves it again", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.");
    retract(root, alias(root, "Evan", EK).id);
    expect(projectedAssertionEntity(root, EVAN.id)).toEqual({ id: EVAN.id, label: "Evan", assertions: 1 });
    expect(searchAssertionEntities(root, "Evan")).toHaveLength(2);
    alias(root, "Evan", JULES);
    expect(projectedAssertionEntity(root, EVAN.id)?.id).toBe(JULES.id);
    expect(projectedAssertionEntity(root, JULES.id)?.label).toBe("Jules Lane");
  });

  test("an older event arriving late does not override a newer one (sync replays by filename)", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.");
    alias(root, "Evan", JULES, { created_at: "2026-08-25T00:00:00.000Z" });
    const older = createIdentityAssertion({ identity: sameAs("Evan", EK), author: AUTHOR,
      created_at: "2026-08-21T00:00:00.000Z", produced_by: PRODUCED });
    appendAssertionEvent(root, older); // to disk only; sync picks it up
    syncAssertionProjection(root);
    expect(projectedAssertionEntity(root, EVAN.id)?.id).toBe(JULES.id);
  });
});

describe("intake never follows the table (#628) and refuses a would-be stub", () => {
  test("[[Evan]] and [[ent_<stub>|…]] are refused once aliased, naming the canonical; the canonical id links", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.");
    alias(root, "Evan", EK);
    expect(() => canonicalizeAssertionLinks(root, "[[Evan]] agreed.")).toThrow(`is an alias of ${EK.id}`);
    expect(() => canonicalizeAssertionLinks(root, `[[${EVAN.id}|Evan Keller]] agreed.`)).toThrow(`is an alias of ${EK.id}`);
    expect(canonicalizeAssertionLinks(root, `[[${EK.id}|Evan Keller]] agreed.`)).toEqual({
      text: `[[${EK.id}|Evan Keller]] agreed.`, entities: [EK], minted: [],
    });
  });

  test("an alias to a label nothing has linked yet resolves READ-side only: dossier and search, never intake", () => {
    const { root } = vault("[[Evan]] said hello.");
    alias(root, "Evan", EK);
    expect(projectedAssertionEntity(root, EVAN.id)).toEqual({ id: EK.id, label: "Evan Keller", assertions: 1, aliases: ["Evan"] });
    expect(searchAssertionEntities(root, "Evan")[0]).toMatchObject({ id: EK.id, label: "Evan Keller", assertions: 1 });
    expect(() => canonicalizeAssertionLinks(root, "[[Evan]] agreed.")).toThrow("is an alias of");
  });

  test("a one-word label an existing entity carries is refused with the candidates, most-cited first", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan Keller]] and [[Jules Lane]] met.", "[[Evan Klein]] wrote.");
    expect(projectedEntityCandidates(root, "Evan").map((c) => [c.label, c.assertions])).toEqual([["Evan Keller", 2], ["Evan Klein", 1]]);
    let refusal = "";
    try { canonicalizeAssertionLinks(root, "[[Evan]] agreed."); } catch (error) { refusal = String(error); }
    expect(refusal).toContain("would mint a new entity beside");
    expect(refusal).toContain(`${EK.id} "Evan Keller" (2)`);
    expect(refusal).toContain(`link one as [[${EK.id}|Evan]]`);
    // the record is untouched by a refusal
    expect(projectedAssertionEntity(root, EVAN.id)).toBeUndefined();
    // two words mint; one word nobody carries mints; a word only an ALIAS carries is refused too
    expect(canonicalizeAssertionLinks(root, "[[Evan Zhang]] wrote.").entities).toEqual([ent("Evan Zhang")]);
    expect(canonicalizeAssertionLinks(root, "[[Zed]] wrote.").entities).toEqual([ent("Zed")]);
    alias(root, "Ezzy K", EK);
    expect(() => canonicalizeAssertionLinks(root, "[[Ezzy]] wrote.")).toThrow("would mint");
  });
});

describe("the readers draw one entity", () => {
  test("the entity view: a stub's path lands on the canonical dossier, links rewritten, aliases in front matter", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello to [[Jules Lane]].");
    alias(root, "Evan", EK);
    const view = assertionEntityView(root, assertionEntityPath(EVAN.id));
    expect(view).toMatchObject({ id: EK.id, label: "Evan Keller", aliases: ["Evan"] });
    expect(view?.assertions.map((row) => row.text)).toEqual([
      "Evan Keller runs FRI.",
      `Evan said hello to [[${assertionEntityPath(JULES.id)}|Jules Lane]].`,
    ]);
    // and Jules's page links the stub's mention to the canonical page
    expect(assertionEntityView(root, assertionEntityPath(JULES.id))?.assertions[0]?.text)
      .toBe(`[[${assertionEntityPath(EK.id)}|Evan]] said hello to Jules Lane.`);
    expect(assertionEntityMarkdown(root, assertionEntityPath(EVAN.id))).toContain('aliases: ["Evan"]');
  });

  test("the graph: no stub node, the canonical node carries the stub's edges", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello to [[Jules Lane]].");
    expect(buildAssertionGraph(root).nodes.filter((n) => n.entity).map((n) => n.title).sort())
      .toEqual(["Evan", "Evan Keller", "Jules Lane"]);
    alias(root, "Evan", EK);
    const graph = buildAssertionGraph(root);
    expect(graph.nodes.filter((n) => n.entity).map((n) => n.title).sort()).toEqual(["Evan Keller", "Jules Lane"]);
    expect(graph.edges.some((e) => [e.source, e.target].sort().join() === [EK.id, JULES.id].sort().join())).toBe(true);
    // the folded-in name stays one it answers to: the field's search finds it by either
    expect(graph.nodes.find((n) => n.id === EK.id)?.aliases).toEqual(["Evan"]);
    expect(graph.nodes.find((n) => n.id === JULES.id)?.aliases).toBeUndefined();
  });
});

describe("intake refuses a lookalike of an existing entity, with a way to insist (lib/entityLookalikes.ts)", () => {
  test("projectedLabelRows: own labels then aliases, canonical ids, merged counts, live only", () => {
    // the third claim links the stub AND the canonical: one claim, not two
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.", "[[Evan]] is [[Evan Keller]].", "[[Jules Lane]] listened.");
    alias(root, "Evan", EK);
    const rows = projectedLabelRows(root);
    expect(rows).toEqual(expect.arrayContaining([
      { id: EK.id, label: "Evan Keller", assertions: 3 },
      { id: EK.id, label: "Evan", assertions: 3 },
      { id: JULES.id, label: "Jules Lane", assertions: 1 },
    ]));
    expect(projectedAssertionEntity(root, EK.id)?.assertions).toBe(3);
    expect(rows).toHaveLength(3);
    expect(rows.findIndex((r) => r.label === "Evan Keller")).toBeLessThan(rows.findIndex((r) => r.label === "Evan"));
  });

  test("a spelling, an initialism, a surname match and a stub's fuller form are refused naming the candidates and the rule", () => {
    const { root } = vault("[[Evan Keller]] runs [[Field Research Institute]].", "[[Briar]] and [[Peter Sutton]] met.");
    const refusal = (text: string): string => { try { canonicalizeAssertionLinks(root, text); } catch (error) { return String(error); } return ""; };
    expect(refusal("[[Evan Kellr]] spoke.")).toContain(`${EK.id} "Evan Keller" (1, spelling)`);
    expect(refusal("[[FRI]] hired.")).toContain(`"Field Research Institute" (1, initials)`);
    expect(refusal("[[Pete Sutton]] spoke.")).toContain(`"Peter Sutton" (1, surname)`);
    const stub = refusal("[[Briar Williams]] spoke.");
    expect(stub).toContain(`"Briar" (1, stub)`);
    expect(stub).toContain("or write [[new:Briar Williams]] if it is a different entity from every candidate");
    // a match through an alias says so
    alias(root, "Evan", EK);
    expect(refusal("[[Evan Keller's lab]] opened.")).toContain(`"Evan Keller" (1, stub via "Evan")`);
    // the record is untouched by a refusal
    expect(projectedLabelRows(root).map((r) => r.label).sort()).toEqual(["Briar", "Evan", "Evan Keller", "Field Research Institute", "Peter Sutton"]);
  });

  test("the ways out lead the refusal, so the submit path's 2,000-character clip never cuts them", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `ent_${String(i).repeat(20)}`, label: `A Very Long Institutional Label Number ${i} For The Study Of Everything Under The Sun`,
      assertions: 9 - i, rule: "token" as const, via: `An Even Longer Alias Number ${i} That This Very Long Institutional Label Also Answers To`,
    }));
    const refusal = lookalikeRefusal("A Very Long New Label For The Study Of Something Else", candidates);
    expect(refusal.length).toBeGreaterThan(2_000);
    expect(refusal.slice(0, 2_000)).toContain("or write [[new:A Very Long New Label For The Study Of Something Else]] if it is a different entity from every candidate");
  });

  test("[[new:label]] insists: the lookalike check is skipped, the id is the bare label's, and an existing label still links", () => {
    const { root } = vault("[[Evan Keller]] runs [[Field Research Institute]].");
    const fli = ent("Future of Life Institute");
    expect(canonicalizeAssertionLinks(root, "[[new:Future of Life Institute]] wrote.")).toEqual({
      text: `[[${fli.id}|Future of Life Institute]] wrote.`, entities: [fli], minted: [fli],
    });
    expect(canonicalizeAssertionLinks(root, "[[New: Evan Keller]] wrote.")).toEqual({
      text: `[[${EK.id}|Evan Keller]] wrote.`, entities: [EK], minted: [],
    });
    // insisting never bypasses the alias table or the one-word stub guard
    alias(root, "Evan", EK);
    expect(() => canonicalizeAssertionLinks(root, "[[new:Evan]] agreed.")).toThrow(`is an alias of ${EK.id}`);
    expect(() => canonicalizeAssertionLinks(root, "[[new:Keller]] agreed.")).toThrow("would mint a new entity beside");
    // and new: on an id is a misread of the refusal, not a link
    expect(() => canonicalizeAssertionLinks(root, `[[new:${EK.id}|Evan Keller]] agreed.`)).toThrow("new: is for a label, not an id");
  });

  test("a label unlike anything in the record mints, and a shared common word is not a lookalike", () => {
    const { root } = vault("[[Field Research Institute]] hired.", "[[Good Food Institute]] hired.", "[[Future of Life Institute]] hired.", "[[Foresight Institute]] hired.");
    const ai = ent("Anthropic Institute");
    expect(canonicalizeAssertionLinks(root, "[[Anthropic Institute]] opened.")).toEqual({
      text: `[[${ai.id}|Anthropic Institute]] opened.`, entities: [ai], minted: [ai],
    });
    expect(canonicalizeAssertionLinks(root, "[[Auto-MAP]] launched.").entities[0]?.label).toBe("Auto-MAP");
  });
});


test("label counts exclude revoked links and retain canonicals known only through aliases", () => {
  const { root } = vault("[[Evan]] spoke.", "[[Jules Lane]] listened.");
  alias(root, "Evan", EK);
  const db = openAssertionProjectionReadonly(root);
  const { id } = db.query("SELECT a.id FROM assertions a JOIN assertion_entities ae ON ae.assertion_id = a.id WHERE ae.entity_id = ?").get(JULES.id) as { id: string };
  db.close();
  retract(root, id);
  expect(projectedLabelRows(root)).toEqual([
    { id: EK.id, label: "Evan Keller", assertions: 1 },
    { id: EK.id, label: "Evan", assertions: 1 },
  ]);
});

test("Unicode lookalikes reach the intake refusal while new: remains available", () => {
  const { root } = vault("[[北京 大学]] has news.", "[[Lukasz Kowalski]] spoke.");
  expect(() => canonicalizeAssertionLinks(root, "[[北京 大学！]] has news.")).toThrow("same");
  expect(() => canonicalizeAssertionLinks(root, "[[Łukasz Kowalski]] spoke.")).toThrow("same");
  expect(canonicalizeAssertionLinks(root, "[[new:北京 大学！]] is different.").entities[0]!.label).toBe("北京 大学！");
});
