import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent, readRecordedAssertions } from "../lib/assertionLog";
import { appendAndProjectAssertion, projectSourceInsertion, recoverAssertionProjection } from "../lib/assertionProjection";
import { appendDeclineEvent, createDeclineEvent } from "../lib/declineLog";
import { appendEntityAliasEvent, createEntityAliasEvent } from "../lib/entityAliasLog";
import { appendEntityFoldRejectEvent, createEntityFoldRejectEvent } from "../lib/entityFoldLog";
import { appendEntitySourceEvent, createEntitySourceEvent } from "../lib/entitySourceLog";
import { appendSourceInsertionEvent, readSourceInsertionLog } from "../lib/insertionLog";
import { importTrees, migrateVault, needsMigration, planMigration, readingDiff, readingOfProjection } from "../lib/migrate";
import { appendRevocationEvent, createRevocationEvent } from "../lib/revocationLog";
import { appendSourceCopyEvent, createSourceCopyEvent } from "../lib/sourceCopyLog";
import { gitVault, insertion } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const person = { kind: "user", id: "owner" } as const;
const model = { kind: "model", id: "judge", invocation_id: "run-1" } as const;
const produced_by = { procedure: "test", version: "1" };
const at = (n: number) => ({ created_at: `2026-09-0${n}T00:00:00Z`, produced_by });
const entity = (label: string) => ({ id: assertionEntityId(label), label });
const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;

/** A vault whose retired logs say a little of everything, committed: as an
 * engine before the assertion kinds left it, the retired logs unprojected. */
function retiredVault() {
  const root = gitVault({ commit: false }); roots.push(root);
  const a = insertion({ id: `ins_${"a".repeat(24)}`, title: "Field notes on the river survey" });
  const b = insertion({ id: `ins_${"b".repeat(24)}`, title: "A second look at the tidal gauges" });
  for (const s of [a, b]) { appendSourceInsertionEvent(root, s); projectSourceInsertion(root, s); }
  const sources = new Map([[a.id, a], [b.id, b]]);
  const ada = entity("Ada Lovelace"), king = entity("Ada King");
  const prose = (text: string, n: number) => createAssertionEvent({ text: `[[${ada.id}|Ada]] ${text}.`, entities: [ada],
    sources: [a.id], confidence: "direct", author: person, ...at(n) }, sources);
  const wrong = prose("surveyed the wrong river", 1), right = prose("surveyed the river", 2);
  for (const p of [wrong, right]) appendAndProjectAssertion(root, p);
  appendRevocationEvent(root, createRevocationEvent({ assertion_id: wrong.id, superseded_by: right.id, reason: "the river", author: person, ...at(3) }));
  appendDeclineEvent(root, createDeclineEvent({ insertion_ids: [b.id], reason: "a calendar stub", author: person, ...at(1) }, sources));
  // "Ada": declared, made its own again, declared toward another; "Lovelace": declared, then moved
  for (const [alias, to, n] of [["Ada", ada, 1], ["Ada", entity("Ada"), 2], ["Ada", king, 3], ["Lovelace", ada, 1], ["Lovelace", king, 4], ["Nobody", entity("Nobody"), 5]] as const)
    appendEntityAliasEvent(root, createEntityAliasEvent({ alias, entity: to, author: person, ...at(n) }));
  for (const [ent, bound, n] of [[ada, true, 1], [ada, false, 2], [king, false, 3]] as const)
    appendEntitySourceEvent(root, createEntitySourceEvent({ entity: ent, insertion_id: a.id, bound, author: person, ...at(n) }));
  appendSourceCopyEvent(root, createSourceCopyEvent({ a: a.id, b: b.id, score: 0.4, author: model, ...at(1) }));
  appendSourceCopyEvent(root, createSourceCopyEvent({ a: a.id, b: b.id, same: true, author: person, ...at(2) }));
  appendSourceCopyEvent(root, createSourceCopyEvent({ a: a.id, b: b.id, score: 0.9, author: model, ...at(3) }));
  appendEntityFoldRejectEvent(root, createEntityFoldRejectEvent({ a: ada, b: king, author: person, ...at(1) }));
  for (const dir of ["log/attestations/2026-08", "log/goal-assertions/2026-08"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "old.json"), "{}\n");
  }
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "the record");
  return { root, ada, king };
}

test("each retired event becomes the assertion that says what it said, latest-wins as retractions", () => {
  const { root } = retiredVault();
  const plan = planMigration(root);
  expect(plan.counts).toEqual({
    "log/declines": { events: 1, assertions: 1 },
    "log/revocations": { events: 1, assertions: 1 },
    // Ada: same, retracted, same; Lovelace: same, then retracted and same; Nobody said nothing
    "log/entity-aliases": { events: 6, assertions: 6 },
    // bound, then unbound; King's unbind withdrew nothing
    "log/entity-sources": { events: 3, assertions: 2 },
    // judged, declared, judged again (the first judgment retracted)
    "log/source-copies": { events: 3, assertions: 4 },
    "log/entity-fold-rejects": { events: 1, assertions: 1 },
  });
  expect(plan.unsaid).toHaveLength(2);
  expect(plan.unread).toEqual({ "log/attestations": 1, "log/goal-assertions": 1 });
  // every one keeps its event's author and time, and names it
  expect(plan.assertions.every((a) => /^(dec|rev|eal|esb|scp|efr)_/u.test(a.migrated_from ?? ""))).toBe(true);
  // the same logs convert to the same assertions, ids and all
  expect(planMigration(root).assertions.map((a) => a.id)).toEqual(plan.assertions.map((a) => a.id));
});

test("a migration proves the new record reads as the old logs did, then commits once", () => {
  const { root } = retiredVault();
  const plan = planMigration(root);
  const head = git(root, "rev-parse", "HEAD");
  expect(migrateVault(root, plan)).toEqual({ written: plan.assertions.length, imported: 0, committed: true });
  expect(readingDiff(plan.before, readingOfProjection(root))).toEqual([]);
  expect(plan.before.aliases).toEqual([`${entity("Ada").id} > ${entity("Ada King").id}`, `${entity("Lovelace").id} > ${entity("Ada King").id}`].sort());
  expect(readdirSync(join(root, "log")).sort()).toEqual(["assertions", "insertions"]);
  expect(readRecordedAssertions(root).filter((a) => a.migrated_from)).toHaveLength(plan.assertions.length);
  expect(git(root, "rev-parse", "HEAD^").trim()).toBe(head.trim());
  expect(git(root, "status", "--porcelain", "--", "log")).toBe("");
  expect(readdirSync(join(root, ".state")).filter((name) => name.startsWith("migrate-"))).toEqual([]);
  expect(needsMigration(root)).toBe(false);
});

test("a vault that still holds a retired log is refused, not read as if it were empty", () => {
  const { root } = retiredVault();
  expect(() => recoverAssertionProjection(root)).toThrow("bigbrain migrate");
});

test("a migration that would read differently puts the vault back as it was", () => {
  const { root } = retiredVault();
  const plan = planMigration(root);
  const tampered = { ...plan, before: { ...plan.before, declined: [...plan.before.declined, "ins_not_declined"] } };
  expect(() => migrateVault(root, tampered)).toThrow("only before: ins_not_declined");
  expect(git(root, "status", "--porcelain", "--", "log")).toBe("");
  expect(existsSync(join(root, "log/declines"))).toBe(true);
  expect(readRecordedAssertions(root).filter((a) => a.migrated_from)).toEqual([]);
  // and it migrates as it would have
  expect(migrateVault(root, plan).committed).toBe(true);
  expect(readingDiff(plan.before, readingOfProjection(root))).toEqual([]);
});

/** A vault from before the insertion log (#496), its inbox ignored by git as
 * the vault template had it: a reference its source was imported from, one
 * landed beside a source of the same id, an inbox copy of that source's
 * content, an inbox arrival and a request no source holds, and a dossier. */
function treesVault() {
  const note = (id: string, body: string) => `---\nid: ${id}\ntitle: Note ${id}\n---\n${body}\n`;
  const root = gitVault({ commit: false, files: {
    ".gitignore": ".state/\ninbox/*.md\n",
    "references/2026-07-01-imported.md": note("ref-imported", "The tidal gauges were recalibrated."),
    "references/2026-07-02-landed.md": note("ref-landed", "The river survey resumed."),
    "inbox/unsorted/.gitkeep": "",
    "inbox/2026-08-01-copy.md": note("inbox-copy", "The river survey resumed."),
    "inbox/2026-08-02-new.md": note("inbox-new", "A sketch of the weir."),
    "requests/done/drop-1.md": note("request-1", "File the weir sketch under hydrology."),
    "entities/ada-lovelace.md": "---\ntitle: Ada Lovelace\naliases: [Ada]\n---\nSurveyor.\n",
  } });
  roots.push(root);
  appendSourceInsertionEvent(root, insertion({ id: `ins_${"c".repeat(24)}`, source_id: "ref-imported",
    body: "The tidal gauges were recalibrated.\n", imported_path: "references/2026-07-01-imported.md" }));
  appendSourceInsertionEvent(root, insertion({ id: `ins_${"d".repeat(24)}`, source_id: "ref-landed", body: "The river survey resumed.\n" }));
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "the record");
  return root;
}

test("what arrived in the old trees and no source holds becomes a source; the trees go", () => {
  const root = treesVault();
  expect(needsMigration(root)).toBe(true);
  const plan = planMigration(root);
  expect(plan.trees.trees).toEqual({
    references: { files: 2, held: 2, repeats: 0, imported: 0 },
    inbox: { files: 2, held: 0, repeats: 1, imported: 1 },
    requests: { files: 1, held: 0, repeats: 0, imported: 1 },
    entities: { files: 1, held: 0, repeats: 0, imported: 0 },
  });
  expect(plan.trees.imports.map((s) => [s.source_id, s.imported_path, s.author])).toEqual([
    ["inbox-new", "inbox/2026-08-02-new.md", { kind: "service", id: "import" }],
    ["request-1", "requests/done/drop-1.md", { kind: "service", id: "import" }],
  ]);
  const result = migrateVault(root, plan);
  expect(result).toMatchObject({ written: 0, imported: 2, committed: true, kept: { files: 2 } });
  for (const tree of ["references", "inbox", "requests", "entities"]) expect(existsSync(join(root, tree))).toBe(false);
  expect(git(root, "status", "--porcelain")).toBe("");
  // git never held the inbox's files, so they wait where the result says
  expect(readdirSync(join(root, result.kept!.path, "inbox")).sort()).toEqual(["2026-08-01-copy.md", "2026-08-02-new.md", "unsorted"]);
  expect(importTrees(join(root, result.kept!.path), readSourceInsertionLog(root)).imports).toEqual([]);
  expect(needsMigration(root)).toBe(false);
});

test("a vault with a note in a retired tree is refused; a tree holding only a .gitkeep says nothing", () => {
  const root = treesVault();
  expect(() => recoverAssertionProjection(root)).toThrow("references, inbox, requests, entities");
  const kept = gitVault({ files: { "inbox/unsorted/.gitkeep": "", "references/.gitkeep": "" } });
  roots.push(kept);
  expect(() => recoverAssertionProjection(kept)).not.toThrow();
});

test("a tree file no source would hold puts the vault back as it was", () => {
  const root = treesVault();
  const plan = planMigration(root);
  expect(() => migrateVault(root, { ...plan, trees: { ...plan.trees, imports: plan.trees.imports.slice(1) } }))
    .toThrow("no source holds 1 files of the retired trees:\ninbox/2026-08-02-new.md");
  expect(git(root, "status", "--porcelain")).toBe("");
  expect(existsSync(join(root, "inbox/2026-08-02-new.md"))).toBe(true);
  expect(readSourceInsertionLog(root)).toHaveLength(2);
});
