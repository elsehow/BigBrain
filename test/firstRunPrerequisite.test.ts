import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("first-run creation surfaces the missing-git remedy from init's JSON without writing a vault", () => {
  const home = mkdtempSync(join(tmpdir(), "bb-first-run-prerequisite-"));
  try {
    const tools = join(home, ".local", "bin"), vault = join(home, "invented-vault");
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const module = resolve("lib/firstRun.ts"), engine = resolve(".");
    const script = `import { createVault } from ${JSON.stringify(module)}; try { createVault(${JSON.stringify(vault)}, ${JSON.stringify(engine)}); process.exit(2); } catch(e) { console.log(e.message); }`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: home, encoding: "utf8", timeout: 30_000,
      env: { HOME: home, PATH: tools + ":/usr/bin:/bin", XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("xcode-select --install");
    expect(result.stdout).toContain("choose the folder again");
    expect(result.stdout).not.toContain("details on stderr");
    expect(existsSync(join(vault, "vault.yaml"))).toBe(false);
    expect(existsSync(join(home, ".config", "bigbrain", "vault"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
