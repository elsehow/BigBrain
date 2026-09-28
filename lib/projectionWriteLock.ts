/** Cross-process single writer for the assertion projection and source admission.
 * A separate SQLite transaction owns the lock across nested projection connections.
 * The OS releases it on process death; no partially published PID file can be
 * mistaken for a stale lock. The lock database must never be unlinked in use. */
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
const held = new Set<string>();
export function withProjectionWrite<T>(root: string, fn: () => T): T {
  const state = resolve(root, ".state"), lock = join(state, "projection-write.sqlite");
  if (held.has(lock)) return fn();
  mkdirSync(state, { recursive: true });
  const db = new Database(lock);
  try {
    db.run("PRAGMA busy_timeout = 30000");
    db.run("BEGIN IMMEDIATE");
    held.add(lock);
    try { return fn(); }
    finally { held.delete(lock); db.run("ROLLBACK"); }
  } finally { db.close(); }
}
