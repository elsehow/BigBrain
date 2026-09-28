import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { mdVault, insertion } from "./support/vault";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { assertionDbPath, openAssertionProjectionReadonly, projectionRevision, rebuildAssertionProjection, syncAssertionProjection } from "../lib/assertionProjection";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mdVault(); roots.push(root);
  const source = insertion();
  const file = appendSourceInsertionEvent(root, source);
  syncAssertionProjection(root);
  return { root, source, file };
}

test("failed catch-up rolls back every new row and keeps the completed revision", () => {
  const { root, file } = fixture();
  const before = projectionRevision(root);
  appendSourceInsertionEvent(root, insertion({ id: "ins_new", source_id: "new" }));
  writeFileSync(join(root, dirname(file.path), "zz_bad.json"), "{}");
  expect(() => syncAssertionProjection(root)).toThrow("unreadable event");
  const db = openAssertionProjectionReadonly(root);
  try {
    expect(projectionRevision(root, db)).toBe(before);
    expect(db.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

test("failed rebuild preserves the old generation and its readable rows", () => {
  const { root, file } = fixture();
  const before = projectionRevision(root);
  writeFileSync(join(root, file.path), "broken");
  expect(() => rebuildAssertionProjection(root)).toThrow();
  expect(projectionRevision(root)).toBe(before);
  const db = openAssertionProjectionReadonly(root);
  try { expect(db.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 1 }); }
  finally { db.close(); }
});

test("a reader keeps one snapshot across a successful rebuild; new readers see the new generation", () => {
  const { root } = fixture();
  const reader = openAssertionProjectionReadonly(root);
  try {
    reader.run("BEGIN");
    const before = projectionRevision(root, reader);
    appendSourceInsertionEvent(root, insertion({ id: "ins_new", source_id: "new" }));
    rebuildAssertionProjection(root);
    expect(projectionRevision(root, reader)).toBe(before);
    expect(reader.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 1 });
    reader.run("COMMIT");
    expect(projectionRevision(root, reader)).not.toBe(before);
    expect(reader.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 2 });
    const current = projectionRevision(root);
    syncAssertionProjection(root);
    expect(projectionRevision(root)).toBe(current);
  } finally { reader.close(); }
});


test("schema replacement rolls back on failure and publishes a complete generation on repair", () => {
  const { root, source, file } = fixture();
  const before = projectionRevision(root);
  const writer = new Database(assertionDbPath(root));
  writer.run("UPDATE meta SET v = '10' WHERE k = 'schema'");
  writer.close();
  writeFileSync(join(root, file.path), "broken");
  expect(() => syncAssertionProjection(root)).toThrow();
  const reader = openAssertionProjectionReadonly(root);
  try {
    reader.run("BEGIN");
    expect(projectionRevision(root, reader)).toBe(before);
    expect(reader.query("SELECT v FROM meta WHERE k = 'schema'").get()).toEqual({ v: "10" });
    writeFileSync(join(root, file.path), JSON.stringify(source));
    syncAssertionProjection(root);
    expect(projectionRevision(root, reader)).toBe(before);
    reader.run("COMMIT");
    expect(projectionRevision(root, reader)).not.toBe(before);
    expect(reader.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 1 });
  } finally { reader.close(); }
});
