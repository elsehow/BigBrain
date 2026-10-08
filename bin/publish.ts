/**
 * publish.ts — the vault's only publisher: push main to origin (GitHub).
 * Offsite backup and the feed for anything reading the vault from the
 * cloud.
 *
 * Offline-tolerant by design: a failed push logs and exits 0; the 15-minute
 * catch-up plist (or the next machine commit's poke) retries. Publishing is
 * eventual, never blocking — no machine writer waits on the network.
 *
 * Usage: bun bin/publish.ts
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { gitProcessEnv } from "../lib/env";
import { ensureDir, writeAtomic } from "../lib/fsx";
import { tryHold } from "../lib/sqliteLock";

const root = VAULT_ROOT;

const stateDir = join(root, ".state");
ensureDir(stateDir);
// Freed the moment this process dies, so a killed push never wedges the next.
const lock = tryHold(join(stateDir, "publish.lock.sqlite"), { retired: join(stateDir, "publish.lock") });
if (!lock) {
  console.log("publish: another publish holds the lock; exiting");
  process.exit(0);
}

try {
  // No origin is a configuration, not a failure (#487): a self-hosted vault
  // with no GitHub remote is complete without one — the offsite copy is
  // opt-in. Say so at info level and stamp it, so the 15-minute catch-up
  // does not fill the log with a fatal every tick.
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", env: gitProcessEnv() });
  const stamp = { lastAttemptAt: new Date().toISOString() } as Record<string, string>;
  if (origin.status !== 0) {
    stamp.skipped = "no-origin";
    console.log("publish: no `origin` remote — nothing to push (opt in: `git remote add origin <url>` in the vault)");
  } else {
    const r = spawnSync("git", ["push", "origin", "main"], {
      cwd: root,
      encoding: "utf8",
      env: gitProcessEnv(),
      timeout: 120_000,
    });
    if (r.status === 0) {
      stamp.lastPushAt = stamp.lastAttemptAt!;
      console.log("publish: origin/main is current");
    } else {
      stamp.lastError = ((r.stderr ?? "") + (r.stdout ?? "")).trim().slice(0, 500);
      console.error(`publish: push failed (offline?) — the sweep retries\n${stamp.lastError}`);
    }
  }
  writeAtomic(join(stateDir, "publish.json"), JSON.stringify(stamp) + "\n");
} finally {
  lock.release();
}
