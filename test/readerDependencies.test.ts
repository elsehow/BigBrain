import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

test("read models and record policies do not depend on voice or identity facades", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const lib = resolve(import.meta.dir, "../lib");
  const forbidden = new Set([resolve(lib, "voice.ts"), resolve(lib, "userIdentity.ts")]);
  const seen = new Set<string>();
  function visit(path: string, chain: string[]): void {
    expect(forbidden.has(path), chain.join(" → ")).toBe(false);
    if (seen.has(path)) return;
    seen.add(path);
    // Erase type-only imports before following runtime dependencies.
    const js = transpiler.transformSync(readFileSync(path, "utf8"));
    for (const dependency of transpiler.scan(js).imports) {
      if (!dependency.path.startsWith(".")) continue;
      let next = resolve(dirname(path), dependency.path);
      if (!existsSync(next)) next += ".ts";
      visit(next, [...chain, dependency.path]);
    }
  }
  for (const name of ["vaultReadModel", "voiceFacts", "userIdentityPolicy"])
    visit(resolve(lib, `${name}.ts`), [name]);
});

test("link syntax and projection readers cannot reach storage-aware link maintenance", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const lib = resolve(import.meta.dir, "../lib");
  function check(start: string, forbidden: string[]) {
    const seen = new Set<string>();
    function visit(path: string, chain: string[]): void {
      expect(forbidden.includes(path), chain.join(" → ")).toBe(false);
      if (seen.has(path)) return;
      seen.add(path);
      const js = transpiler.transformSync(readFileSync(path, "utf8"));
      for (const dependency of transpiler.scan(js).imports) {
        if (!dependency.path.startsWith(".")) {
          if (start === "linkSyntax") expect(dependency.path.startsWith("node:"), chain.join(" → ")).toBe(false);
          continue;
        }
        let next = resolve(dirname(path), dependency.path);
        if (!existsSync(next)) next += ".ts";
        visit(next, [...chain, dependency.path]);
      }
    }
    visit(resolve(lib, `${start}.ts`), [start]);
  }
  check("linkSyntax", ["references", "assertionProjection", "links", "vaultRead"].map(name => resolve(lib, `${name}.ts`)));
  for (const name of ["assertionProjection", "markdownGraph", "vaultRead"])
    check(name, [resolve(lib, "links.ts")]);
});

test("integration storage and configuration cannot reach policy or provider workflows", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const lib = resolve(import.meta.dir, "../lib");
  const forbidden = new Set(["integrationAccess", "integrationAccounts", "integrationPoll", "stage", "thatTracks", "granolaMcpPoll"].map(name => resolve(lib, `${name}.ts`)));
  const seen = new Set<string>();
  function visit(path: string, chain: string[]): void {
    expect(forbidden.has(path), chain.join(" → ")).toBe(false);
    if (seen.has(path)) return;
    seen.add(path);
    const js = transpiler.transformSync(readFileSync(path, "utf8"));
    for (const dependency of transpiler.scan(js).imports) {
      if (!dependency.path.startsWith(".")) continue;
      let next = resolve(dirname(path), dependency.path);
      if (!existsSync(next)) next += ".ts";
      visit(next, [...chain, dependency.path]);
    }
  }
  for (const name of ["emailConfig", "emailState", "integrationCursor", "integrationStatus", "stageStorage"])
    visit(resolve(lib, `${name}.ts`), [name]);
});
