import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

test("navigation and Pilot owners depend on coordination contracts, never on each other", () => {
  const directory = resolve(import.meta.dir, "../web/ui/src/lib");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const [start, names] of [
    ["store.svelte", ["pilotChat.svelte", "workSessions.svelte", "sourceAttention.svelte", "applicationCoordinator"]],
    ["pilotChat.svelte", ["store.svelte", "workSessions.svelte", "sourceAttention.svelte", "applicationCoordinator"]],
  ] as const) {
    const forbidden = new Set(names.map(name => resolve(directory, name + ".ts")));
    const seen = new Set<string>();
    function visit(path: string, chain: string[]): void {
      expect(forbidden.has(path), chain.join(" → ")).toBe(false);
      if (seen.has(path)) return;
      seen.add(path);
      const js = transpiler.transformSync(readFileSync(path, "utf8"));
      for (const item of transpiler.scan(js).imports) {
        if (!item.path.startsWith(".")) continue;
        let next = resolve(dirname(path), item.path);
        if (!existsSync(next)) next += ".ts";
        visit(next, [...chain, item.path]);
      }
    }
    visit(resolve(directory, start + ".ts"), [start]);
  }
});
