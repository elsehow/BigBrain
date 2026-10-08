/** sqliteLock.ts — a cross-process lock, and a little state under it, in a
 * private SQLite file, as lib/projectionWriteLock.ts holds the projection:
 * BEGIN IMMEDIATE takes it and the OS lets it go the moment its process dies,
 * so there is never a stale lock to judge (no pid liveness, no reused pids,
 * nothing to sweep). Two ways to hold it: for an instant, waiting
 * synchronously; or across slow async work, never waiting synchronously. The
 * file must never be unlinked while in use. */
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The lock's file, made private (0600 in a 0700 directory) before SQLite opens it; its journal takes the same mode. */
function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "", { flag: "a", mode: 0o600 });
  return new Database(path);
}

/** Whether SQLite refused because another connection holds the lock. */
export const lockBusy = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "SQLITE_BUSY";

/** Run `fn` holding the lock, for work that takes an instant: a holder
 * elsewhere is waited for up to `waitMs`, synchronously (then SQLITE_BUSY is
 * thrown). What `fn` writes commits as it returns; a throw rolls it back. */
export function withLockedDatabase<T>(path: string, fn: (db: Database) => T, waitMs: number): T {
  const db = open(path);
  try {
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
    db.run("BEGIN IMMEDIATE");
    try {
      const result = fn(db);
      db.run("COMMIT");
      return result;
    } catch (error) {
      // SQLite may have rolled back already (a full disk, an I/O error): its error is the one to tell
      try { db.run("ROLLBACK"); } catch { /* no transaction left */ }
      throw error;
    }
  } finally { db.close(); }
}

/** The locks the current async call chain holds through withHeldLock. Another
 * chain in this process is a contender like any other process, and waits. */
const holding = new AsyncLocalStorage<ReadonlySet<string>>();

/** Hold the lock across slow async work, such as a network call. It never
 * waits synchronously (that would freeze this process's event loop for as
 * long as another process holds the lock): it asks again every 50 ms until
 * `wait` ms pass, then throws `busy`, or `signal` aborts. Released when `fn`
 * settles, or when this process dies. Taking it again inside `fn` throws at
 * once: it would wait on itself. */
export async function withHeldLock<T>(path: string, fn: () => Promise<T>, o: { busy: string; signal?: AbortSignal; wait?: number }): Promise<T> {
  const key = resolve(path), held = holding.getStore() ?? new Set<string>();
  if (held.has(key)) throw Error(`This already holds the lock at ${path}; holding it again inside would wait on itself.`);
  const db = open(path);
  try {
    db.run("PRAGMA busy_timeout = 0");
    for (const deadline = Date.now() + (o.wait ?? 30_000); ;) {
      try {
        db.run("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!lockBusy(error)) throw error;
      }
      o.signal?.throwIfAborted();
      if (Date.now() > deadline) throw Error(o.busy);
      await new Promise(r => setTimeout(r, 50));
    }
    try { return await holding.run(new Set([...held, key]), fn); } finally { db.run("ROLLBACK"); }
  } finally { db.close(); }
}
