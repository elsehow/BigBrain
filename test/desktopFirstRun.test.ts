import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";

test("the real first-run door identifies its own supervisor before a vault exists", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-first-run-"));
  const vault = join(home, "new-vault"), config = join(home, ".config", "bigbrain");
  // An older install's group/world-readable config dir.
  mkdirSync(config, { recursive: true }); chmodSync(config, 0o755);
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const child = Bun.spawn([process.execPath, join(ENGINE_ROOT, "bin/desktop.ts")], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, BIGBRAIN_VAULT: vault, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_DESKTOP: "1", BIGBRAIN_DEV: "1" },
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  try {
    let identity: { engine: string; supervisor: number | null } | undefined;
    for (let i = 0; i < 150; i++) {
      try {
        const response = await fetch(`${base}/api/engine`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { identity = await response.json(); break; }
      } catch { /* the supervisor is still starting */ }
      if (child.exitCode !== null) throw new Error(`Setup door exited: ${await errors}`);
      await Bun.sleep(40);
    }
    expect(identity).toBeDefined();
    expect(identity!.engine).toBe(ENGINE_ROOT);
    expect(identity!.supervisor).toBe(child.pid);
    expect(statSync(config).mode & 0o777).toBe(0o700);
    const setup = await fetch(`${base}/api/setup`).then(response => response.json());
    expect(setup.vault).toBeNull();
    expect(existsSync(vault)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    await errors;
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
