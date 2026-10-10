import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendAndProjectAssertion, appendAndProjectDecline, appendAndProjectRevocation, projectionChangesSince,
  projectionRevision, projectNotes, projectSourceInsertion, rebuildAssertionProjection, recoverAssertionProjection, syncAssertionProjection,
} from "../lib/assertionProjection";
import { createAssertionEvent } from "../lib/assertionLog";
import { createDeclineEvent } from "../lib/declineLog";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { createRevocationEvent } from "../lib/revocationLog";
import { insertion, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const author = { kind: "model" as const, id: "test", invocation_id: "run-1" };
const produced_by = { procedure: "test", version: "v1" };
const at = (root: string) => projectionRevision(root)!;
/** Everything logged since `since`, as `revision kind:id op` lines. */
const since = (root: string, from: string) =>
  projectionChangesSince(root, from)?.changes.map((c) => `${c.revision} ${c.kind}:${c.id} ${c.op}`);

function vault() {
  const root = mdVault({ dirs: ["memory"] }); roots.push(root);
  const a = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "a" });
  appendSourceInsertionEvent(root, a);
  syncAssertionProjection(root);
  return { root, a };
}

test("every commit logs what moved the revision, in commit order", () => {
  const { root, a } = vault();
  const start = at(root), [generation, first] = start.split(":");
  const b = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "b" });
  appendSourceInsertionEvent(root, b); projectSourceInsertion(root, b);
  const claim = createAssertionEvent({ text: "A fabricated claim about the orrery.", entities: [], sources: [a.id], author,
    confidence: "direct", created_at: "2026-09-01T00:00:00.000Z", produced_by }, new Map([[a.id, a]]));
  appendAndProjectAssertion(root, claim);
  const decline = createDeclineEvent({ insertion_ids: [b.id], reason: "Boilerplate", author, created_at: "2026-09-01T00:00:00.000Z", produced_by }, new Map([[b.id, b]]));
  appendAndProjectDecline(root, decline);
  const revoked = createRevocationEvent({ assertion_id: claim.id, reason: "wrong", author, created_at: "2026-09-02T00:00:00.000Z", produced_by });
  appendAndProjectRevocation(root, revoked);
  // a replay of an event already projected commits nothing
  projectSourceInsertion(root, b);
  const n = Number(first);
  expect(since(root, start)).toEqual([
    `${n + 1} source:${b.id} add`, `${n + 2} assertion:${claim.id} add`,
    `${n + 3} decline:${decline.id} add`, `${n + 4} revocation:${revoked.id} add`,
  ]);
  expect(at(root)).toBe(`${generation}:${n + 4}`);
  expect(since(root, at(root))).toEqual([]);
});

test("notes log as their door projects them created, edited and deleted; one commit per pass", () => {
  const { root } = vault();
  const start = at(root), n = Number(start.split(":")[1]);
  writeFileSync(join(root, "memory", "orrery.md"), "# Orrery\n\nFirst.\n");
  writeFileSync(join(root, "memory", "gears.md"), "# Gears\n\nFour.\n");
  syncAssertionProjection(root);
  expect(since(root, start)).toEqual([]); // a read never looks at the files
  projectNotes(root, ["memory/orrery.md", "memory/gears.md"]);
  writeFileSync(join(root, "memory", "orrery.md"), "# Orrery\n\nSecond, longer.\n");
  rmSync(join(root, "memory", "gears.md"));
  projectNotes(root, ["memory"]);
  expect(since(root, start)).toEqual([
    `${n + 1} markdown:memory/gears.md add`, `${n + 1} markdown:memory/orrery.md add`,
    `${n + 2} markdown:memory/gears.md remove`, `${n + 2} markdown:memory/orrery.md edit`,
  ]);
});

test("a source retracted and restored by hand logs through recovery", () => {
  const { root, a } = vault();
  const start = at(root), n = Number(start.split(":")[1]);
  rmSync(join(root, insertionEventRel(a)));
  recoverAssertionProjection(root);
  mkdirSync(join(root, insertionEventRel(a), ".."), { recursive: true });
  writeFileSync(join(root, insertionEventRel(a)), JSON.stringify(a));
  recoverAssertionProjection(root);
  expect(since(root, start)).toEqual([`${n + 1} source:${a.id} remove`, `${n + 2} source:${a.id} add`]);
});

test("a coordinate from another generation, or from the future, asks for a snapshot", () => {
  const { root } = vault();
  const before = at(root), [generation, revision] = before.split(":");
  expect(projectionChangesSince(root, `${generation}:${Number(revision) + 1}`)).toBeUndefined();
  rebuildAssertionProjection(root);
  expect(at(root).split(":")[0]).not.toBe(generation);
  expect(projectionChangesSince(root, before)).toBeUndefined();
  // the rebuilt log starts at its own beginning, every event in replay order
  expect(since(root, `${at(root).split(":")[0]}:0`)?.length).toBeGreaterThan(0);
});
