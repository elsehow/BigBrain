/** sqliteLock.test.ts — a SQLite-file lock held across processes: freed the
 * moment its holder dies, and waited for without blocking the event loop. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockBusy, withHeldLock, withLockedDatabase } from "../lib/sqliteLock";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const module = join(import.meta.dir, "../lib/sqliteLock.ts");

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-sqlitelock-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** Another process holding the lock until it is killed. */
async function holder(lock: string) {
  const child = Bun.spawn([process.execPath, "-e", `const { withHeldLock } = await import(${JSON.stringify(module)});
    // holds until killed: a pending timer keeps the work, and so its lock, alive
    await withHeldLock(process.env.LOCK, async () => { console.log("held"); await new Promise(r => setTimeout(r, 600_000)); }, { busy: "busy" });`],
    { env: { ...process.env, LOCK: lock }, stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => child.kill(9));
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  return child;
}

test("a lock is private, and freed the moment the process holding it dies", async () => {
  const root = scratch(), lock = join(root, "keys", "a.lock.sqlite"), child = await holder(lock);
  expect(statSync(join(root, "keys")).mode & 0o777).toBe(0o700);
  expect(statSync(lock).mode & 0o777).toBe(0o600);
  await expect(withHeldLock(lock, async () => "mine", { busy: "Held elsewhere.", wait: 200 })).rejects.toThrow("Held elsewhere.");
  child.kill(9);
  await child.exited;
  const started = performance.now();
  expect(await withHeldLock(lock, async () => "mine", { busy: "Held elsewhere.", wait: 5_000 })).toBe("mine");
  expect(performance.now() - started).toBeLessThan(500);
});

test("waiting for a lock held elsewhere never blocks the event loop, and stops when aborted", async () => {
  const root = scratch(), lock = join(root, "a.lock.sqlite");
  await holder(lock);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  try {
    await expect(withHeldLock(lock, async () => "mine", { busy: "Held elsewhere.", wait: 600 })).rejects.toThrow("Held elsewhere.");
    expect(ticks).toBeGreaterThan(10);
    const started = performance.now();
    await expect(withHeldLock(lock, async () => "mine", { busy: "Held elsewhere.", signal: AbortSignal.timeout(150) })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally { clearInterval(timer); }
});

test("an instant's hold waits only its bound, and what it writes commits or rolls back with it", async () => {
  const root = scratch(), lock = join(root, "budget.sqlite");
  const count = () => withLockedDatabase(lock, db => {
    db.run("CREATE TABLE IF NOT EXISTS n (v INTEGER)");
    return (db.query("SELECT count(*) AS c FROM n").get() as { c: number }).c;
  }, 1_000);
  expect(count()).toBe(0);
  withLockedDatabase(lock, db => { db.run("INSERT INTO n VALUES (1)"); }, 1_000);
  expect(() => withLockedDatabase(lock, db => { db.run("INSERT INTO n VALUES (2)"); throw Error("undone"); }, 1_000)).toThrow("undone");
  expect(count()).toBe(1);
  await holder(lock);
  const started = performance.now();
  let refused: unknown;
  try { count(); } catch (error) { refused = error; }
  expect(lockBusy(refused)).toBe(true);
  expect(performance.now() - started).toBeLessThan(3_000);
});
