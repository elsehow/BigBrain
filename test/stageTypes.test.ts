import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  parseAssertionId, parseEntityId, parseEnvelopeId, parseInsertionId, parseVaultPath, type EntityId, type InsertionId,
} from "../lib/ids";
import { memoKey, waiting, type MemoStage, type RecordStage, type StageInput } from "../lib/stages/stage";
import type { CacheKey, Snapshot } from "../lib/views/view";

test("a branded id is made only by its parser, which refuses anything else", () => {
  const ins: InsertionId = parseInsertionId(`ins_${"a".repeat(24)}`);
  expect<string>(ins).toBe(`ins_${"a".repeat(24)}`);
  expect(() => parseInsertionId(`ent_${"a".repeat(20)}`)).toThrow("not an insertion id");
  expect<string>(parseEntityId(`ent_${"b".repeat(20)}`)).toBe(`ent_${"b".repeat(20)}`);
  expect(() => parseAssertionId("ast_short")).toThrow("not an assertion id");
  expect<string>(parseEnvelopeId("minutes 2026-08-02")).toBe("minutes 2026-08-02");
  expect(() => parseEnvelopeId("two\nlines")).toThrow();
  expect(() => parseEnvelopeId("")).toThrow();
  expect<string>(parseVaultPath("log/insertions/2026-08/x.json")).toBe("log/insertions/2026-08/x.json");
  for (const bad of ["/etc/passwd", "../outside", "log//x", "log/./x", "log\\x", ""])
    expect(() => parseVaultPath(bad)).toThrow("not a vault path");
  // @ts-expect-error an insertion id is not an entity id
  const _entity: EntityId = ins;
  void _entity;
});

// A toy stage over a table: the shape every stage takes, and the one rule
// that says whether it has work.
const snapshot = (): Snapshot => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE notes (id TEXT, body TEXT)");
  db.run("CREATE TABLE verdicts (note TEXT, ok INTEGER)");
  for (const [id, body] of [["n1", "alpha"], ["n2", "beta"], ["n3", "alpha"]] as const) db.run("INSERT INTO notes VALUES (?, ?)", [id, body]);
  db.run("INSERT INTO verdicts VALUES ('n2', 1)");
  return { db, revision: "r1", cache: "toy" as CacheKey };
};
const notes = ({ db }: Snapshot): StageInput<string>[] =>
  (db.query("SELECT id, body FROM notes ORDER BY id").all() as { id: string; body: string }[]).map((n) => ({ id: n.id, hash: n.body, item: n.body }));
const run = async () => {};

test("a record stage waits on the inputs none of its outputs settles", () => {
  const judge: RecordStage<string, { note: string; ok: boolean }> = {
    name: "judge", version: "1", output: "record", inputs: notes, run,
    written: ({ db }) => (db.query("SELECT note, ok FROM verdicts").all() as { note: string; ok: number }[]).map((v) => ({ note: v.note, ok: !!v.ok })),
    settles: (verdict) => [verdict.note],
  };
  expect(waiting(judge, snapshot()).map((i) => i.id)).toEqual(["n1", "n3"]);
});

test("a memo stage waits on the inputs with no answer under its version; one answer serves equal content", () => {
  const brief: MemoStage<string, string> = { name: "brief", version: "2", output: "memo", inputs: notes, run };
  const memo = new Map([[memoKey(brief, { hash: "alpha" }), "about alpha"], [memoKey({ name: "brief", version: "1" }, { hash: "beta" }), "stale"]]);
  expect(waiting(brief, snapshot(), memo).map((i) => i.id)).toEqual(["n2"]);
});
