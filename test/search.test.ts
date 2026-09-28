/** search.test.ts — the CLI door's --why behavior (#498: the legacy FTS
 * module lib/search.ts died with the editor pass — its unit suites went
 * with it; the live search path is the assertion projection, covered by
 * test/assertionProjection.test.ts and the api tests. What remains here
 * is bin/search.ts's demand-spooling contract: machine passes never
 * spool, an interactive why lands as a voice arrival, #521.) */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { NATIVE_YAML } from "./support/vault";

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bb-vault-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("machine-pass whys never spool", () => {
  const spawnSearch = (root: string, extraEnv: Record<string, string>) =>
    spawnSync("bun", [join(ENGINE_ROOT, "bin", "search.ts"), "product", "--why", "demo why"], {
      encoding: "utf8" as const,
      env: {
        ...process.env,
        BIGBRAIN_VAULT: root,
        BIGBRAIN_SEARCH_DB: join(root, ".state", "search.db"),
        ...extraEnv,
      },
    });

  const hostVault = (): string => {
    const root = vault({
      "entities/big-brain.md": "---\ntitle: Big Brain\n---\n\nthe product\n",
      // #495: the CLI door searches only the assertion projection now; the
      // flag is what makes a fresh vault searchable (the tests here are
      // about --why spooling, not hits)
      "vault.yaml": NATIVE_YAML,
    });
    mkdirSync(join(root, ".state"), { recursive: true });
    return root;
  };

  for (const role of ["memory", "editor"]) {
    test(`BIGBRAIN_ROLE=${role}: the search runs, the spool stays empty, stderr says why`, () => {
      const root = hostVault();
      const r = spawnSearch(root, { BIGBRAIN_ROLE: role });
      expect(r.status).toBe(0);
      expect(existsSync(join(root, "observations", "pending"))).toBe(false);
      expect(r.stderr).toContain(`the ${role} pass is machinery, not demand`);
      // the closed door names the open one
      expect(r.stderr).toContain("bigbrain observe");
    });
  }

  test("no BIGBRAIN_ROLE: an interactive why still lands — as a voice arrival (#521)", () => {
    const root = hostVault();
    const r = spawnSearch(root, { BIGBRAIN_ROLE: "" });
    expect(r.status).toBe(0);
    // no spool file — the observation is an insertion event now
    expect(existsSync(join(root, "observations", "pending"))).toBe(false);
    const voice = readSourceInsertionLog(root).filter(
      (e) => e.envelope["kind"] === "observation"
    );
    expect(voice).toHaveLength(1);
    expect(voice[0]!.envelope["query"]).toBeDefined();
  });
});
