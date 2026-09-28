import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { nativeVault, insertion } from "./support/vault";
import { syncAssertionProjection, projectedSourceHeads, searchAssertionSources } from "../lib/assertionProjection";

test("version 9 projections rebuild source headers without changing search results", () => {
  const source = insertion({ title: "Atlas record", body: "Atlas evidence. ".repeat(10000), envelope: { kind: "meeting", source: "granola" } });
  const root = nativeVault({ insertions: [source] });
  try {
    syncAssertionProjection(root);
    const before = searchAssertionSources(root, "Atlas");
    const db = new Database(join(root, ".state", "assertions.db"));
    db.run("DROP INDEX sources_headers");
    db.run("DROP INDEX sources_kind");
    db.run("ALTER TABLE sources DROP COLUMN envelope_kind");
    db.run("ALTER TABLE sources DROP COLUMN envelope_source");
    db.run("UPDATE meta SET v='9' WHERE k='schema'");
    db.close();
    expect(syncAssertionProjection(root).sources).toBe(1);
    expect(searchAssertionSources(root, "Atlas")).toEqual(before);
    expect(projectedSourceHeads(root, [source.id]).get(source.id)).toMatchObject({ kind: "meeting", source: "granola" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("materialized headers preserve missing and non-string envelope semantics", () => {
  const sources = [insertion({ id: "ins_1", envelope: {} }), insertion({ id: "ins_2", envelope: { kind: 42, source: false } })];
  const root = nativeVault({ insertions: sources });
  try {
    syncAssertionProjection(root);
    const heads = projectedSourceHeads(root, sources.map(s => s.id));
    for (const head of heads.values()) { expect(head.kind).toBeUndefined(); expect(head.source).toBeUndefined(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
