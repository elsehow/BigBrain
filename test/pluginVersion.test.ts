// clients/claude-plugin — every change bumps the version, because Claude Code
// copies a plugin into its cache keyed by plugin.json's version and
// `claude plugin update` is a no-op while that version matches (verified
// 2026-08-28; lib/pluginState.ts). A content change under the same version
// never reaches anyone's Claude Code. This test pins (version, content hash)
// and fails with instructions when they move apart.
//
// README.md is not in the hash: docs need no re-copy.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { shippedPluginVersion } from "../lib/pluginState";

const PLUGIN = join(import.meta.dir, "..", "clients", "claude-plugin");
const SKIP = new Set([".DS_Store", "README.md"]);

/** Bump plugin.json's version, then set both fields to what the failure prints. */
const PINNED = { version: "0.1.24", sha256: "de54ba98ce1125ee69adaf7436a3e014e03957c395c153a7504442a252869173" };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (!SKIP.has(name)) out.push(p);
  }
  return out;
}

export function pluginContentHash(root: string = PLUGIN): string {
  const h = createHash("sha256");
  for (const f of walk(root).sort((a, b) => (relative(root, a) < relative(root, b) ? -1 : 1))) {
    h.update(relative(root, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

describe("the plugin's version moves with its content", () => {
  test("plugin.json's version and the content hash are the pinned pair", () => {
    const version = shippedPluginVersion(join(import.meta.dir, ".."));
    const sha256 = pluginContentHash();
    const moved = version !== PINNED.version;
    const changed = sha256 !== PINNED.sha256;
    if (changed && !moved) {
      throw new Error(
        `clients/claude-plugin changed without a version bump — Claude Code would keep its cached ${version} ` +
          `(the cache is keyed by version; \`claude plugin update\` ignores same-version content). ` +
          `Bump .claude-plugin/plugin.json, then set PINNED in test/pluginVersion.test.ts to { version: "<new>", sha256: "${sha256}" }.`
      );
    }
    if (moved || changed) {
      throw new Error(`plugin ${version}: set PINNED in test/pluginVersion.test.ts to { version: "${version}", sha256: "${sha256}" }`);
    }
    expect(version).toBe(PINNED.version);
    expect(sha256).toBe(PINNED.sha256);
  });
});
