// Shared base colors and semantic aliases in the app and generated extension tokens.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";

const VIEWER_TOKENS = join(ENGINE_ROOT, "web/ui/src/design/tokens.css");
const EXTENSION_TOKENS = join(ENGINE_ROOT, "clients/browser-extension/tokens.css");

/** Base knobs and derived semantic aliases; palette overrides and
 * component-local variables are outside the shared token surface. */
function baseTokens(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const block = [...text.matchAll(/:root(?:, \[data-theme\])? \{([^}]*?)\}/g)]
    .map((m) => m[1]).join("\n");
  const tokens = new Map<string, string>();
  for (const m of block.matchAll(/^\s*(--[\w-]+):\s*(.+?);\s*$/gm)) {
    tokens.set(m[1]!, m[2]!.trim());
  }
  return tokens;
}

describe("token sync — web/ui/src/design/tokens.css ↔ clients/browser-extension/tokens.css", () => {
  test("every token name the two files share resolves to the identical value", () => {
    const viewer = baseTokens(VIEWER_TOKENS);
    const extension = baseTokens(EXTENSION_TOKENS);
    const shared = [...extension.keys()].filter((name) => viewer.has(name));

    // Guard against a missing or renamed token block passing vacuously.
    expect(shared.length).toBeGreaterThan(50);

    const mismatches = shared
      .filter((name) => viewer.get(name) !== extension.get(name))
      .map((name) => `${name}: viewer=${viewer.get(name)} extension=${extension.get(name)}`);
    expect(mismatches).toEqual([]);
  });
});
