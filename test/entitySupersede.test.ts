/** entitySupersede.test.ts — revoke + reassert (#629) and canonical-only linking (#628).
 *
 * The invariants: a revocation retires an assertion from every reader while
 * its row (and redirect) survive; a superseding copy is a plain assertion
 * with the original's date, sources and display words; an emptied stub is
 * gone from the record and its label unclaimed; the insertion it settled
 * stays settled; a rebuild reproduces the projection; intake never follows
 * an alias, refuses a retired id with its successor in hand, and refuses to
 * re-mint a superseded label.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeAssertionLinks } from "../lib/assertionAgent";
import { assertionEntityPath, assertionEntityView } from "../lib/assertionEntityView";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityId, createAssertionEvent, readAssertionLog, type AssertionEntity } from "../lib/assertionLog";
import {
  appendAndProjectAssertion,
  appendAndProjectEntityAlias,
  appendAndProjectRevocation,
  assertionProjectionDigest,
  assertionProjectionStats,
  projectSourceInsertion,
  projectedEntityRow,
  rebuildAssertionProjection,
  resolveAssertionId,
  retiredEntitySuccessor,
  searchAssertionEntities,
} from "../lib/assertionProjection";
import { createEntityAliasEvent } from "../lib/entityAliasLog";
import { correctedAssertion, supersedeEntity, SUPERSEDE_AUTHOR } from "../lib/entitySupersede";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import {
  appendRevocationEvent,
  createRevocationEvent,
  readRevocationLog,
  resolveAssertionIdIn,
  revokedAssertions,
  validateRevocationEvent,
} from "../lib/revocationLog";
import { dueIntakeCount } from "../lib/work";
import { insertion } from "./support/vault";

const PRODUCED = { procedure: "test", version: "v1" } as const;
const MODEL = { kind: "model", id: "m", invocation_id: "r" } as const;
const ent = (label: string): AssertionEntity => ({ id: assertionEntityId(label), label });
const EK = ent("Evan Keller");
const EVAN = ent("Evan");
const JULES = ent("Jules Lane");

let tick = 0;
const stamp = (): string => `2026-08-20T10:${String(tick++).padStart(2, "0")}:00.000Z`;

/** A vault with one source and the given assertions, each `[[label]]`
 * minted directly — the record as it stood before the guard. */
function vault(...texts: string[]): { root: string; ins: SourceInsertion; ids: string[] } {
  const root = mkdtempSync(join(tmpdir(), "bb-supersede-"));
  const ins = insertion({ id: "ins_super00000000000000000a", body: "Evan and Jules talked.", occurred_at: "2026-08-18T10:00:00.000Z" });
  appendSourceInsertionEvent(root, ins);
  projectSourceInsertion(root, ins);
  const ids: string[] = [];
  for (const text of texts) {
    const entities: AssertionEntity[] = [];
    const linked = text.replace(/\[\[([^\]|]+)\]\]/g, (_all, label: string) => {
      const e = ent(label);
      if (!entities.some((held) => held.id === e.id)) entities.push(e);
      return `[[${e.id}|${label}]]`;
    });
    const event = createAssertionEvent({
      text: linked, entities, sources: [ins.id], author: MODEL,
      confidence: "direct", created_at: stamp(), produced_by: PRODUCED,
    }, new Map([[ins.id, ins]]));
    appendAndProjectAssertion(root, event);
    ids.push(event.id);
  }
  return { root, ins, ids };
}

describe("the revocation log", () => {
  test.each([false, true])("revocation winners survive reversed arrival order and replay (reverse=%s)", (reverse) => {
    const { root, ids } = vault("[[Evan]] proposed the original claim.", "[[Evan Keller]] proposed the first correction.", "[[Jules Lane]] proposed another correction.");
    const revocations = ids.slice(1).map((id) => createRevocationEvent({
      assertion_id: ids[0]!, superseded_by: id, reason: `correct to ${id}`,
      author: SUPERSEDE_AUTHOR, produced_by: PRODUCED, created_at: "2026-09-04T00:00:00Z",
    })).sort((a, b) => b.id.localeCompare(a.id));
    // Earlier time, later filename: a filename-ordered replay must agree
    // with a live writer, including a late-arriving earlier correction.
    revocations[1]!.created_at = "2026-09-05T00:00:00Z";
    for (const event of reverse ? [...revocations].reverse() : revocations)
      appendAndProjectRevocation(root, event);
    const expected = resolveAssertionIdIn(revokedAssertions(root), ids[0]!);
    expect(resolveAssertionId(root, ids[0]!)).toBe(expected);
    const digest = assertionProjectionDigest(root);
    rebuildAssertionProjection(root);
    expect(resolveAssertionId(root, ids[0]!)).toBe(expected);
    expect(assertionProjectionDigest(root)).toBe(digest);
  });

  test("an event round-trips, validates, and supersession resolves through a chain", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-rev-log-"));
    const a = "ast_000000000000000000000001", b = "ast_000000000000000000000002", c = "ast_000000000000000000000003";
    const first = createRevocationEvent({ assertion_id: a, superseded_by: b, reason: "link fixed", author: SUPERSEDE_AUTHOR, created_at: stamp(), produced_by: PRODUCED });
    const second = createRevocationEvent({ assertion_id: b, superseded_by: c, reason: "again", author: SUPERSEDE_AUTHOR, created_at: stamp(), produced_by: PRODUCED });
    const plain = createRevocationEvent({ assertion_id: c, reason: "withdrawn", author: { kind: "user", id: "nick" }, created_at: stamp(), produced_by: PRODUCED });
    expect(appendRevocationEvent(root, first).deduped).toBe(false);
    expect(appendRevocationEvent(root, first).deduped).toBe(true);
    appendRevocationEvent(root, second);
    appendRevocationEvent(root, plain);
    expect(readRevocationLog(root, { strict: true })).toHaveLength(3);
    const revoked = revokedAssertions(root);
    expect(resolveAssertionIdIn(revoked, a)).toBe(c); // a → b → c, c revoked with no successor: stands as the last
    expect(resolveAssertionIdIn(revoked, "ast_0000000000000000000000ff")).toBe("ast_0000000000000000000000ff");
    expect(() => validateRevocationEvent({ ...first, superseded_by: a })).toThrow("cannot supersede itself");
    expect(() => validateRevocationEvent({ ...first, reason: "" })).toThrow("reason");
  });
});

describe("supersede: the stub's assertions move, one by one", () => {
  test("copies carry the original's date, sources and words; the stub vanishes; the insertion stays settled; a rebuild agrees", () => {
    const { root, ins, ids } = vault(
      "[[Evan Keller]] runs FRI.",
      "[[Evan]] said hello to [[Jules Lane]].",
      "[[Evan]] and [[Evan Keller]] met.",
    );
    expect(dueIntakeCount(root)).toBe(0);
    const originals = readAssertionLog(root, { strict: true });
    const r = supersedeEntity(root, { from: "Evan", into: "Evan Keller", operator: "nick" });
    expect(r.items).toHaveLength(2);
    expect(r.left).toBe(0);
    expect(r.appended).toBe(2);

    // the stub is gone; the person holds everything, count 3
    expect(projectedEntityRow(root, EVAN.id)).toBeUndefined();
    expect(projectedEntityRow(root, EK.id)?.assertions).toBe(3);
    expect(searchAssertionEntities(root, "Evan").map((h) => h.label)).toEqual(["Evan Keller"]);
    expect(assertionProjectionStats(root).assertions).toBe(3);
    expect(dueIntakeCount(root)).toBe(0);

    // the live log: three claims, none linking the stub; five with the revoked
    const live = readAssertionLog(root, { strict: true });
    expect(live).toHaveLength(3);
    expect(live.every((e) => e.entities.every((x) => x.id !== EVAN.id))).toBe(true);
    expect(readAssertionLog(root, { strict: true, includeRevoked: true })).toHaveLength(5);

    // the copy: original date and sources, display words kept, procedure author, supersedes
    const hello = originals.find((e) => e.id === ids[1])!;
    const copy = live.find((e) => e.supersedes === hello.id)!;
    expect(copy.created_at).toBe(hello.created_at);
    expect(copy.sources).toEqual(hello.sources);
    expect(copy.text).toBe(`[[${EK.id}|Evan]] said hello to [[${JULES.id}|Jules Lane]].`);
    expect(copy.author).toEqual(SUPERSEDE_AUTHOR);
    expect(copy.produced_by.procedure).toBe("entity-supersede");
    expect(copy.confidence).toBe(hello.confidence);
    // the one that linked both: a single declared entity, two links to it
    const met = live.find((e) => e.supersedes === ids[2])!;
    expect(met.entities).toEqual([EK]);
    expect(met.text).toBe(`[[${EK.id}|Evan]] and [[${EK.id}|Evan Keller]] met.`);

    // the revocation names the operator and the successor; the old id redirects
    const revocation = revokedAssertions(root).get(hello.id)!;
    expect(revocation.superseded_by).toBe(copy.id);
    expect(revocation.reason).toContain("by nick");
    expect(revocation.reason).toContain("[[Evan]] → " + EK.id);
    expect(resolveAssertionId(root, hello.id)).toBe(copy.id);
    expect(resolveAssertionId(root, copy.id)).toBe(copy.id);
    expect(retiredEntitySuccessor(root, EVAN.id)).toEqual(EK);

    // readers draw one entity, words preserved
    const view = assertionEntityView(root, assertionEntityPath(EK.id))!;
    expect(view.assertions.map((row) => row.text)).toEqual([
      "Evan Keller runs FRI.",
      `Evan said hello to [[${assertionEntityPath(JULES.id)}|Jules Lane]].`,
      "Evan and Evan Keller met.",
    ]);
    expect(assertionEntityView(root, assertionEntityPath(EVAN.id))).toBeUndefined();
    expect(buildAssertionGraph(root).nodes.filter((n) => n.entity).map((n) => n.title).sort()).toEqual(["Evan Keller", "Jules Lane"]);

    // disposable projection: a rebuild from the logs is the same projection
    const before = assertionProjectionDigest(root);
    rebuildAssertionProjection(root);
    expect(assertionProjectionDigest(root)).toBe(before);
    expect(projectedEntityRow(root, EVAN.id)).toBeUndefined();

    // nothing left to do
    expect(() => supersedeEntity(root, { from: "Evan", into: "Evan Keller", operator: "nick" })).toThrow("nothing live");
    expect(ins.id).toBe(copy.sources![0]!.insertion_id);
  });

  test("a mixed stub splits by hand: --assertion picks, the rest stays live; a label nothing linked is minted by the copies", () => {
    const { root, ids } = vault("[[Vera]] maintains LEAP.", "[[Vera]] wrote an eval-variance paper.", "[[Vera]] joined the core team.");
    const stone = ent("Vera Stone");
    const r = supersedeEntity(root, { from: "Vera", into: "Vera Stone", only: [ids[0]!, ids[2]!], operator: "nick" });
    expect(r.into).toEqual(stone);
    expect(r.items.map((i) => i.original)).toEqual([ids[0], ids[2]]);
    expect(r.left).toBe(1);
    expect(projectedEntityRow(root, ent("Vera").id)?.assertions).toBe(1);
    expect(projectedEntityRow(root, stone.id)).toMatchObject({ label: "Vera Stone", assertions: 2 });
    expect(() => supersedeEntity(root, { from: "Vera", into: "Vera Quinn", only: [ids[0]!], operator: "nick" }))
      .toThrow("not a live assertion");
    // dry run plans without writing
    const dry = supersedeEntity(root, { from: "Vera", into: "Vera Quinn", operator: "nick", dryRun: true });
    expect(dry.items).toHaveLength(1);
    expect(dry.appended).toBe(0);
    expect(projectedEntityRow(root, ent("Vera").id)?.assertions).toBe(1);
  });

  test("correctedAssertion rewrites only the stub's links", () => {
    const original = createAssertionEvent({
      text: `[[${EVAN.id}|Evan]] met [[${JULES.id}|Jules]].`, entities: [EVAN, JULES],
      citations: [{ insertion_id: "ins_super00000000000000000a", quotes: ["Evan"] }],
      author: MODEL, confidence: "candidate", created_at: stamp(), produced_by: PRODUCED,
    }, new Map([["ins_super00000000000000000a", insertion({ id: "ins_super00000000000000000a", body: "Evan and Jules talked.", occurred_at: "2026-08-18T10:00:00.000Z" })]]));
    expect(correctedAssertion(original, EVAN, EK)).toEqual({
      text: `[[${EK.id}|Evan]] met [[${JULES.id}|Jules]].`, entities: [EK, JULES],
    });
  });
});

describe("intake links the canonical thing only (#628)", () => {
  test("a label or id that is an alias is refused naming the canonical; the canonical itself is accepted", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.");
    appendAndProjectEntityAlias(root, createEntityAliasEvent({ alias: "Evan", entity: EK, author: { kind: "user", id: "nick" }, created_at: stamp(), produced_by: PRODUCED }));
    expect(() => canonicalizeAssertionLinks(root, "[[Evan]] agreed.")).toThrow(`"Evan" is an alias of ${EK.id} "Evan Keller" — link [[${EK.id}|Evan]]`);
    expect(() => canonicalizeAssertionLinks(root, `[[${EVAN.id}|Evan Keller]] agreed.`)).toThrow(`${EVAN.id} is an alias of ${EK.id}`);
    expect(canonicalizeAssertionLinks(root, `[[${EK.id}|Evan]] agreed.`)).toEqual({ text: `[[${EK.id}|Evan]] agreed.`, entities: [EK] });
    expect(canonicalizeAssertionLinks(root, "[[Evan Keller]] agreed.").entities).toEqual([EK]);
  });

  test("a retired id is refused with its successor; a superseded one-word label hits the guard; a superseded fuller label is refused with the pointer", () => {
    const { root } = vault("[[Evan Keller]] runs FRI.", "[[Evan]] said hello.", "[[Lina Pan]] wrote.", "[[Lina Piao]] wrote too.");
    supersedeEntity(root, { from: "Evan", into: "Evan Keller", operator: "nick" });
    supersedeEntity(root, { from: "Lina Piao", into: "Lina Pan", operator: "nick" });
    expect(() => canonicalizeAssertionLinks(root, `[[${EVAN.id}|Evan]] agreed.`))
      .toThrow(`${EVAN.id} is retired — its assertions were superseded into ${EK.id} "Evan Keller": link [[${EK.id}|Evan]]`);
    expect(() => canonicalizeAssertionLinks(root, "[[Evan]] agreed.")).toThrow("would mint a new entity beside");
    expect(() => canonicalizeAssertionLinks(root, "[[Lina Piao]] agreed.")).toThrow(`"Lina Piao" was superseded into ${ent("Lina Pan").id} "Lina Pan"`);
    // an unrelated new person still mints
    expect(canonicalizeAssertionLinks(root, "[[Evan Klein]] wrote.").entities).toEqual([ent("Evan Klein")]);
    expect(() => canonicalizeAssertionLinks(root, "[[ent_00000000000000000000|Ghost]] appeared.")).toThrow("unknown projected entity");
  });
});
