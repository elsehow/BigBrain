import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";

/**
 * One import-time vault resolution, in one file.
 *
 * lib/manifest.ts used to carry `export const VAULT_ROOT = requireVaultRoot()`,
 * which made THE config reader un-importable in any process without a vault.
 * Six lib/ modules documented their way around it and lib/transcriptProjection.ts
 * re-implemented the vault.yaml parse rather than import the one that already
 * existed. Both facts below are what keep that from growing back.
 */

const libFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ts")) out.push(p);
    }
  };
  walk(join(ENGINE_ROOT, "lib"));
  return out;
};

describe("the vault is resolved at import in exactly one place", () => {
  test("only lib/vaultRoot.ts calls requireVaultRoot() at module scope", () => {
    const callers = libFiles().filter((p) => /^\s*(export )?const .*= requireVaultRoot\(\)/m.test(readFileSync(p, "utf8")));
    expect(callers.map((p) => relative(ENGINE_ROOT, p))).toEqual(["lib/vaultRoot.ts"]);
  });

  // A lib/ module takes `root` as an argument: it may be running against a
  // scratch vault, a test fixture, or no vault at all. Importing the constant
  // instead is how the reader got stuck the first time.
  test("no lib/ module imports it — entry points only", () => {
    const importers = libFiles().filter(
      (p) => p !== join(ENGINE_ROOT, "lib", "vaultRoot.ts") && /from "\.\/vaultRoot"/.test(readFileSync(p, "utf8"))
    );
    expect(importers.map((p) => relative(ENGINE_ROOT, p))).toEqual([]);
  });
});

/** Import a module in a process that can find NO vault: no BIGBRAIN_VAULT, a
 * cwd with no vault.yaml above it, and a HOME with no pointer file. */
const importWithNoVault = (mod: string): { code: number; err: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "bb-novault-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "bb-novault-home-"));
  const p = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(join(ENGINE_ROOT, mod))})`], {
    cwd,
    env: { PATH: process.env["PATH"]!, HOME: home },
  });
  return { code: p.exitCode, err: p.stderr.toString() };
};

describe("what loads without a vault", () => {
  // lib/api.ts serves machines that hold no vault; the desktop shell opens the
  // first-run door before one exists. Both reach the config reader.
  test.each(["lib/manifest.ts", "lib/config.ts", "lib/configWrite.ts", "lib/transcriptProjection.ts", "lib/api.ts", "lib/preflight.ts"])(
    "%s imports clean",
    (mod) => {
      const r = importWithNoVault(mod);
      expect(r.err).not.toContain("no vault found");
      expect(r.code).toBe(0);
    }
  );

  test("lib/vaultRoot.ts is the one that throws, and says how to fix it", () => {
    const r = importWithNoVault("lib/vaultRoot.ts");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no vault found");
    expect(r.err).toContain("BIGBRAIN_VAULT");
  });
});
