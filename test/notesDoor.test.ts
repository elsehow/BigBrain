import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { projectNotes, projectionChangesSince, projectionRevision, syncAssertionProjection } from "../lib/assertionProjection";
import { vaultRecord } from "../lib/vaultReadModel";
import { mdVault } from "./support/vault";

// The notes door (#225): Markdown, the one input people edit outside the
// engine, reaches the projection only through projectNotes — named by the
// viewer's watcher, an engine pass, or a process's census at start. A read
// never looks at the files.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function vault() {
  const root = mdVault({ dirs: ["memory"] }); roots.push(root);
  writeFileSync(join(root, "memory", "orrery.md"), "# Orrery\n\nFirst.\n");
  writeFileSync(join(root, "memory", "gears.md"), "# Gears\n\nFour.\n");
  syncAssertionProjection(root); // this process's census finds them
  return root;
}
const titles = (root: string) => vaultRecord(root).documents.map((d) => d.title).sort();
const logged = (root: string, since: string) => projectionChangesSince(root, since)!.changes.map((c) => `${c.id} ${c.op}`);

test("a read never looks at the files; the door projects what it is named, and only that", () => {
  const root = vault();
  const start = projectionRevision(root)!;
  writeFileSync(join(root, "memory", "orrery.md"), "# Orrery, revised\n");
  writeFileSync(join(root, "memory", "gears.md"), "# Gears, revised\n");
  expect(titles(root)).toEqual(["Gears", "Orrery"]);
  projectNotes(root, ["memory/orrery.md"]);
  expect(titles(root)).toEqual(["Gears", "Orrery, revised"]);
  expect(logged(root, start)).toEqual(["memory/orrery.md edit"]);
});

test("a folder names everything under it: nested additions, and a folder deleted whole", () => {
  const root = vault();
  const start = projectionRevision(root)!;
  mkdirSync(join(root, "memory", "workshop", "bench"), { recursive: true });
  writeFileSync(join(root, "memory", "workshop", "bench", "lathe.md"), "# Lathe\n");
  writeFileSync(join(root, "memory", "workshop", "vice.md"), "# Vice\n");
  projectNotes(root, ["memory/workshop"]);
  expect(titles(root)).toEqual(["Gears", "Lathe", "Orrery", "Vice"]);
  rmSync(join(root, "memory", "workshop"), { recursive: true });
  projectNotes(root, ["memory/workshop"]);
  expect(titles(root)).toEqual(["Gears", "Orrery"]);
  expect(logged(root, start)).toEqual([
    "memory/workshop/bench/lathe.md add", "memory/workshop/vice.md add",
    "memory/workshop/bench/lathe.md remove", "memory/workshop/vice.md remove",
  ]);
  // what is outside the trees a person browses, or dotted, is never a note
  mkdirSync(join(root, "memory", ".trash"));
  writeFileSync(join(root, "memory", ".trash", "old.md"), "# Old\n");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "stray.md"), "# Stray\n");
  projectNotes(root, ["memory/.trash/old.md", "memory/.trash", "log/stray.md", "log"]);
  expect(titles(root)).toEqual(["Gears", "Orrery"]);
});

test("notes edited while no process watched are found by the next process's census", () => {
  const root = vault();
  writeFileSync(join(root, "memory", "orrery.md"), "# Orrery, edited while closed\n");
  expect(titles(root)).toEqual(["Gears", "Orrery"]); // this process already took its census
  const next = spawnSync(process.execPath, ["-e", `
    const { vaultRecord } = await import(${JSON.stringify(new URL("../lib/vaultReadModel.ts", import.meta.url).pathname)});
    console.log(JSON.stringify(vaultRecord(${JSON.stringify(root)}).documents.map((d) => d.title).sort()));
  `], { env: { ...process.env, BIGBRAIN_VAULT: root, BIGBRAIN_ASSERTION_DB: "" }, encoding: "utf8" });
  expect(next.status, next.stderr).toBe(0);
  expect(JSON.parse(next.stdout.trim().split("\n").at(-1)!)).toEqual(["Gears", "Orrery, edited while closed"]);
});
