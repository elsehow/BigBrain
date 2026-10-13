import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Views are pure and only stages call models
// (docs/plans/2026-10-12-stages-and-views-refactor.md, Method). TypeScript
// cannot prove a function pure, so these fail on the shapes that make one
// impure: a view that can reach the disk, git, the network or a model, that
// is handed `root` instead of a snapshot, or that reads the clock, a random
// number, or trigonometry whose last bits differ between JS engines.
const repo = resolve(import.meta.dir, "..");
const walk = (dir: string): string[] => readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? (d.name === "node_modules" ? [] : walk(join(dir, d.name))) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []);
// comments may name what code may not
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const read = (file: string) => code(readFileSync(join(repo, file), "utf8"));

/** Every module a file imports, as a repo-relative path without extension
 * (a bare specifier stays as written), with the names it takes as values. */
function imports(file: string): { module: string; names: string[] | "all" }[] {
  const text = read(file);
  const at = (spec: string) => spec.startsWith(".") ? relative(repo, resolve(repo, dirname(file), spec)).replace(/\.ts$/, "") : spec;
  const out: { module: string; names: string[] | "all" }[] = [];
  for (const m of text.matchAll(/\bimport\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (m[1]) continue;
    const braces = /\{([^}]*)\}/.exec(m[2]!)?.[1];
    const names = braces === undefined ? "all" as const
      : braces.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ")).map((n) => n.split(/\s+as\s+/)[0]!);
    out.push({ module: at(m[3]!), names });
  }
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push({ module: at(m[1]!), names: "all" });
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push({ module: at(m[1]!), names: "all" });
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g))
    if (!/^export\s+type\b/.test(m[0])) out.push({ module: at(m[1]!), names: "all" });
  return out;
}

const views = walk("lib/views");

test("there are views to guard", () => {
  expect(views).toContain("lib/views/v2Read.ts");
});

test("a view reaches nothing but its snapshot", () => {
  const forbidden = (module: string) => /^(node:)?(fs|fs\/promises|child_process)$/.test(module)
    || /^lib\/(git|sharedJev|askModel|vaultRoot)$/.test(module) || /^lib\/(run|stages)\//.test(module);
  const offenders = views.flatMap((file) => imports(file).filter((i) => forbidden(i.module)).map((i) => `${file} imports ${i.module}`));
  expect(offenders).toEqual([]);
});

test("a view takes a snapshot, never root", () => {
  expect(views.filter((file) => /\broot\??\s*:\s*string\b/.test(read(file)))).toEqual([]);
});

test("a view reads no clock, no randomness, no engine-rounded math", () => {
  const impure = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\.(random|sin|cos|hypot|atan2)\s*\(|\brandomUUID\b|\bBun\.(file|write|spawn|spawnSync)\b|\bfetch\s*\(/;
  expect(views.filter((file) => impure.test(read(file)))).toEqual([]);
});

// Only stages call models. These modules do today and have not become
// stages yet; the refactor removes each as it moves its call into
// lib/stages/. The list only shrinks: an entry that no longer calls a model
// fails until it is removed, and a module not on it fails when it starts.
// Operational calls (connection checks, the model catalog, the agents' web
// search and scan reader, Pilot's sessions) settle nothing and stay.
const NOT_YET_STAGES = [
  "lib/diagnostics.ts",
  "lib/entityFolds.ts",
  "lib/feedStage.ts",
  "lib/inclusionQueries.ts",
  "lib/memoryRun.ts",
  "lib/pilotBackend.ts",
  "lib/scanReader.ts",
  "lib/sharedRuleEvaluator.ts",
  "lib/sourceCopyJudge.ts",
  "lib/tend.ts",
  "lib/webSearch.ts",
];
/** The model runners, and the names each exports that call a model. */
const RUNNERS: Record<string, string[]> = {
  "lib/run/model": ["runModel"],
  "lib/run/agent": ["runAgent"],
  "lib/run/sessionJob": ["runSessionJob"],
  "lib/run/sessionFactory": ["createModelSession"],
  "lib/askModel": ["askModel"],
};
const callsModel = (file: string) => imports(file).some(({ module, names }) =>
  module in RUNNERS && (names === "all" || names.some((n) => RUNNERS[module]!.includes(n))));

test("only stages call models", () => {
  const engine = ["bin", "lib", "integrations"].flatMap(walk).concat(walk("web").filter((f) => !f.startsWith("web/ui/")));
  const calling = engine.filter((file) => !file.startsWith("lib/stages/") && !file.startsWith("lib/run/") && callsModel(file));
  expect(calling.filter((file) => !NOT_YET_STAGES.includes(file))).toEqual([]);
  expect(NOT_YET_STAGES.filter((file) => !calling.includes(file))).toEqual([]);
});
