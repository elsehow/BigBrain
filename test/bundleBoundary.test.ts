/**
 * bundleBoundary.test.ts — engine-side code must not import from web/ui/src.
 *
 * The desktop bundle carries what the engine RUNS and nothing else
 * (desktop/build-resources.sh): web/ui/src is excluded, because the viewer
 * ships built, as web/ui/dist. So an import of `web/ui/src/…` from anything
 * the engine executes — lib/, bin/, integrations/, web/server.ts — resolves
 * in the checkout and fails inside the app. Nothing else catches that: the
 * dev loop and CI both run from a checkout where the file exists.
 *
 * Desktop 0.1.14 shipped exactly this. web/server.ts had imported
 * `./ui/src/lib/errText` since #304; the excludes were mis-rooted until
 * #654, so the file rode along by accident and everything worked. #654
 * fixed the excludes, the next release's viewer died on every start with
 * "Cannot find module", and the app's 30s watchdog reported the engine had
 * never answered. This test is the guard #654 needed.
 *
 * The other direction — the viewer importing from lib/ — is fine and
 * common (slug, wire, graphGeometry): Vite bundles what it reaches.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Every .ts file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** What the engine runs: the excludes in desktop/build-resources.sh are the
 * authority on what the bundle drops; these are the trees that must not
 * depend on any of it. */
const ENGINE_SIDE = [
  ...tsFiles(join(ROOT, "lib")),
  ...tsFiles(join(ROOT, "bin")),
  ...tsFiles(join(ROOT, "integrations")),
  join(ROOT, "web", "server.ts"),
];

/** Import and re-export specifiers, static and dynamic. */
const SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

describe("the engine does not import what the bundle strips", () => {
  test("no engine-side file imports from web/ui/src", () => {
    const offenders: string[] = [];
    for (const file of ENGINE_SIDE) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(SPECIFIER)) {
        const spec = m[1] ?? "";
        if (/(^|\/)ui\/src(\/|$)/.test(spec)) offenders.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard reads the trees it claims to", () => {
    // A refactor that empties one of these lists would turn the test above
    // into a vacuous pass.
    expect(ENGINE_SIDE.length).toBeGreaterThan(50);
    expect(ENGINE_SIDE.some((f) => f.endsWith("web/server.ts"))).toBe(true);
  });
});
