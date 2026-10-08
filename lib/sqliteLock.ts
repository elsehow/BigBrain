/** sqliteLock.ts — a cross-process lock, and a little state under it, in a
 * private SQLite file, as lib/projectionWriteLock.ts holds the projection:
 * BEGIN IMMEDIATE takes it and the OS lets it go the moment its process dies,
 * so there is never a stale lock to judge (no pid liveness, no reused pids,
 * nothing to sweep). Three ways to hold it: for an instant, waiting
 * synchronously; across slow async work, never waiting synchronously; or for
 * a single-flight run or server, only if it is free right now. The file must
 * never be unlinked while in use. */
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeAtomic } from "./fsx";

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

/** A lock taken by tryHold, kept until `release()` or this process's death. */
export interface Hold { release(): void }

/** Every hold's connection, kept from the collector: closing it would let
 * the lock go at a moment nobody chose. */
const holds = new Set<Database>();

/** Lock directories earlier versions took, removed on this process's first
 * hold of the lock that replaced each. Harmless left behind; litter. */
const swept = new Set<string>();

/** Locks whose holder record could not be written, each said once. */
const unrecorded = new Set<string>();

/** Where a hold writes who took it, beside the lock. It is for telling a
 * person who has the lock (lockHolder), never for judging whether anyone
 * does: only the lock says that. */
const holderFile = (path: string): string => path.replace(/(\.sqlite)?$/, ".holder");

/** Take the lock if it is free, never waiting for it: null when another
 * process, or another hold in this one, has it. The hold lasts across any
 * async work until `release()`, and the OS lets it go the moment this
 * process dies. `name` labels the line printed when someone else has it;
 * `retired` is the lock directory an earlier version took in its place. */
export function tryHold(path: string, o: { name?: string; retired?: string } = {}): Hold | null {
  const db = open(path);
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (!lockBusy(error)) throw error;
    if (o.name) {
      const pid = lockHolder(path);
      console.log(`${o.name}: another run holds the lock${pid ? ` (pid ${pid})` : ""}; exiting`);
    }
    return null;
  }
  holds.add(db);
  try { writeAtomic(holderFile(path), `${JSON.stringify({ pid: process.pid })}\n`, 0o600); } catch (error) {
    // Held regardless, but isHeld reads a lock with no record as idle
    if (!unrecorded.has(path)) {
      unrecorded.add(path);
      console.error(`Could not record this process as the holder of ${path} (${error instanceof Error ? error.message : String(error)}); it reads as idle while held.`);
    }
  }
  if (o.retired && !swept.has(o.retired)) {
    swept.add(o.retired);
    rmSync(o.retired, { recursive: true, force: true });
  }
  return {
    release() {
      if (!holds.delete(db)) return;
      // The record goes BEFORE the lock, on purpose: after it, a successor may have
      // written its own, which this must not remove (nor can a probe: it clears one
      // only while holding the lock itself)
      try { rmSync(holderFile(path), { force: true }); } catch { /* the next hold overwrites it */ }
      try { db.run("ROLLBACK"); } finally { db.close(); }
    },
  };
}

/** Is the lock held right now, by anyone, this process included? The lock
 * is asked only while a holder's record stands, so an idle lock is left
 * alone; a record whose holder died is cleared by the asking, under the
 * lock. Never throws: unknown reads as free. */
export function isHeld(path: string): boolean {
  try {
    if (!existsSync(holderFile(path))) return false;
    const db = open(path);
    try {
      db.run("PRAGMA busy_timeout = 0");
      try { db.run("BEGIN IMMEDIATE"); } catch (error) { return lockBusy(error); }
      try { rmSync(holderFile(path), { force: true }); } finally { db.run("ROLLBACK"); }
      return false;
    } finally { db.close(); }
  } catch { return false; }
}

/** The pid the lock's last holder recorded: who has it, for a person to
 * read when isHeld or tryHold says someone does. */
export function lockHolder(path: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(holderFile(path), "utf8")) as { pid?: unknown };
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
