import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { vaultRecord } from "../lib/vaultReadModel";
import { syntheticVault } from "./support/syntheticVault";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "bb-synthetic-")); dirs.push(dir); return dir; };
const files = (root: string, dir = root): [string, string][] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.name === ".state" || d.name === ".git" ? [] : d.isDirectory() ? files(root, join(dir, d.name)) : [[relative(root, join(dir, d.name)), readFileSync(join(dir, d.name), "utf8")] as [string, string]]);

const a = fresh(), b = fresh();
const counts = syntheticVault(a, { sources: 400, seed: 7 });
syntheticVault(b, { sources: 400, seed: 7 });

test("the same seed writes the same vault, byte for byte", () => {
  expect(files(b)).toEqual(files(a));
  const head = (root: string) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout;
  expect(head(b)).toBe(head(a));
  expect(counts.sources).toBe(400);
});

test("a different seed writes a different vault", () => {
  const c = fresh();
  syntheticVault(c, { sources: 400, seed: 8 });
  expect(files(c)).not.toEqual(files(a));
});

test("it holds every shape a refactor can get wrong", () => {
  const record = vaultRecord(a);
  const graph = buildAssertionGraph(a, undefined, record);
  const rows = record.rows;
  expect(record.superseded.size).toBeGreaterThan(0);
  expect(record.threadByInsertion.size).toBeGreaterThan(0);
  expect(record.copies.size).toBeGreaterThan(0);
  expect(record.revoked.size).toBeGreaterThan(0);
  expect(rows.some((r) => r.supersedes)).toBe(true);
  expect(rows.some((r) => (r.sources?.length ?? 0) > 1)).toBe(true);
  expect(new Set(rows.map((r) => r.author.kind))).toEqual(new Set(["model", "agent", "user"]));
  expect(record.aliases.canonical.size).toBeGreaterThan(0);
  expect(record.entitySources.length).toBeGreaterThan(0);
  expect(record.declined.size).toBeGreaterThan(0);
  expect([...record.sources.keys()].some((id) => !record.cited.has(id) && !record.declined.has(id))).toBe(true); // pending
  expect(record.documents.length).toBe(counts.memory);
  expect(new Set(graph.nodes.map((n) => n.group))).toEqual(new Set(["entity", "memory", "source"]));
});

test("it refuses to write over anything", () => {
  expect(() => syntheticVault(a)).toThrow("is not empty");
});
