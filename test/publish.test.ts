/** publish.test.ts — bin/publish.ts runs one push at a time, and a killed
 * push never wedges the ones after it. The vault has no origin, so nothing
 * reaches the network: the run says so and stamps .state/publish.json. */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { holdElsewhere } from "./support/lockElsewhere";
import { gitVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const publish = (root: string): string => {
  const r = Bun.spawnSync([process.execPath, join(ENGINE_ROOT, "bin/publish.ts")], {
    cwd: root, env: { ...process.env, BIGBRAIN_VAULT: root }, stdout: "pipe", stderr: "pipe",
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
};

test("a second publish skips while another process holds the lock, and publishes once that one is killed", async () => {
  const root = gitVault({ files: { "vault.yaml": "{}\n" } });
  roots.push(root);
  mkdirSync(join(root, ".state", "publish.lock"), { recursive: true }); // what a killed publish left before: it stopped every one after
  const other = await holdElsewhere("sqliteLock.ts", "tryHold", [join(root, ".state", "publish.lock.sqlite")]);
  try {
    expect(publish(root)).toContain("publish: another publish holds the lock; exiting");
  } finally { await other.kill(); }
  expect(publish(root)).toContain("no `origin` remote");
  expect(existsSync(join(root, ".state", "publish.json"))).toBe(true);
  expect(existsSync(join(root, ".state", "publish.lock"))).toBe(false);
});
