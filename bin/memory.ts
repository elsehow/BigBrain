/**
 * memory.ts — the memory pass's CLI shell. The run body lives in
 * lib/memoryRun.ts (extracted 2026-08-07 so the pass is testable: a
 * top-level body meant importing anything from here executed a sweep).
 * This file resolves the vault, reads argv, and maps the result to an
 * exit code. Nothing else.
 *
 * Usage: bun bin/memory.ts [--force] [--from-scratch [--keep-tree]]
 *
 * --from-scratch is the native regeneration procedure (#459): both log
 * cursors cleared, the existing memory/ tree moved to an isolated backup
 * under journal/memory/, then a bootstrap-posture run over the record
 * alone. --keep-tree backs up by copy and leaves the tree in place — the
 * one way old memory is ever an input to a regeneration. Implies --force.
 */

import { loadManifest } from "../lib/manifest";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { runMemory } from "../lib/memoryRun";

const res = await runMemory({
  root: VAULT_ROOT,
  warmBriefings: true,
  manifest: loadManifest(VAULT_ROOT),
  force: process.argv.includes("--force"),
  fromScratch: process.argv.includes("--from-scratch"),
  keepTree: process.argv.includes("--keep-tree"),
});

// exitCode, never process.exit(): the latter tears down immediately, and a
// hard exit inside the runner would strand its lock (harmless only because
// the lock is pid-aware — noisy all the same).
if (res.error) process.exitCode = 1;
