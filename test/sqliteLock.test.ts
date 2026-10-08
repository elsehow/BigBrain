/** sqliteLock.test.ts — a SQLite-file lock held across processes: freed the
 * moment its holder dies, waited for without blocking the event loop, and
 * never held twice, however its contenders race. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHeld, lockBusy, lockHolder, tryHold, withHeldLock, withLockedDatabase } from "../lib/sqliteLock";
import { holdElsewhere } from "./support/lockElsewhere";

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

test("holding a lock again inside its own hold throws at once; another call chain in the process waits its turn", async () => {
  const root = scratch(), lock = join(root, "a.lock.sqlite"), o = { busy: "Held elsewhere.", wait: 5_000 };
  const started = performance.now();
  await expect(withHeldLock(lock, () => withHeldLock(lock, async () => "inner", o), o)).rejects.toThrow("holding it again inside would wait on itself");
  expect(performance.now() - started).toBeLessThan(1_000);
  const order: string[] = [];
  const hold = (name: string) => withHeldLock(lock, async () => { order.push(name + " in"); await Bun.sleep(100); order.push(name + " out"); }, o);
  await Promise.all([hold("a"), hold("b")]);
  expect(order).toEqual(["a in", "a out", "b in", "b out"]);
});

test("an error SQLite already rolled back for is the one reported", () => {
  const root = scratch(), lock = join(root, "budget.sqlite");
  expect(() => withLockedDatabase(lock, db => { db.run("ROLLBACK"); throw Error("disk full"); }, 100)).toThrow("disk full");
});

/** Processes that each take the lock only if it is free, at the same
 * instant, and hold what they get for `holdMs`: what each said. */
async function race(lock: string, n: number, holdMs: number): Promise<string[]> {
  const at = Date.now() + 300;
  const children = Array.from({ length: n }, () => Bun.spawn([process.execPath, "-e", `const { tryHold } = await import(${JSON.stringify(module)});
    while (Date.now() < ${at}) {}
    const hold = tryHold(process.env.LOCK);
    console.log(hold ? "held" : "busy");
    await Bun.sleep(${holdMs});`], { env: { ...process.env, LOCK: lock }, stdout: "pipe", stderr: "inherit" }));
  cleanups.push(() => { for (const child of children) child.kill(9); });
  return Promise.all(children.map(async child => (await new Response(child.stdout).text()).trim()));
}

test("a single-flight hold is refused to a second taker at once, says who has it, and is freed the moment its process dies", async () => {
  const root = scratch(), lock = join(root, "pass.lock.sqlite"), other = await holdElsewhere("sqliteLock.ts", "tryHold", [lock]);
  cleanups.push(() => void other.kill());
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const started = performance.now();
    expect(tryHold(lock, { name: "pass" })).toBeNull();
    expect(performance.now() - started).toBeLessThan(100); // asked once, never waited for
    expect(log).toHaveBeenCalledWith(`pass: another run holds the lock (pid ${other.pid}); exiting`);
  } finally { log.mockRestore(); }
  expect(isHeld(lock)).toBe(true);
  expect(lockHolder(lock)).toBe(other.pid);
  await other.kill();
  expect(isHeld(lock)).toBe(false);
  expect(lockHolder(lock)).toBeNull(); // the dead holder's record, cleared by the asking
  const hold = tryHold(lock)!;
  expect(hold).not.toBeNull();
  expect(lockHolder(lock)).toBe(process.pid);
  expect(statSync(join(root, "pass.lock.holder")).mode & 0o777).toBe(0o600);
  expect(tryHold(lock)).toBeNull(); // another hold in this process is a contender like any other
  expect(isHeld(lock)).toBe(true);
  hold.release();
  hold.release(); // a second release lets go of nothing
  expect(isHeld(lock)).toBe(false);
  tryHold(lock)!.release();
});

test("the record never decides: a hold without one still refuses, and a record without a hold is cleared, even naming a live pid", async () => {
  const root = scratch(), lock = join(root, "pass.lock.sqlite"), other = await holdElsewhere("sqliteLock.ts", "tryHold", [lock]);
  cleanups.push(() => void other.kill());
  rmSync(join(root, "pass.lock.holder")); // the instant between a hold and its record, made to last
  expect(tryHold(lock)).toBeNull();
  await other.kill();
  writeFileSync(join(root, "pass.lock.holder"), `${JSON.stringify({ pid: 1 })}\n`); // pid 1 is always alive
  expect(isHeld(lock)).toBe(false);
  expect(existsSync(join(root, "pass.lock.holder"))).toBe(false);
  tryHold(lock)!.release();
});

test("contenders racing for a free lock, or one whose holder was just killed, never make two holders", async () => {
  const root = scratch(), lock = join(root, "pass.lock.sqlite");
  const free = await race(lock, 6, 400);
  expect(free.filter(said => said === "held")).toHaveLength(1);
  expect(free.filter(said => said === "busy")).toHaveLength(5);
  const dead = await holdElsewhere("sqliteLock.ts", "tryHold", [lock]);
  await dead.kill(); // its record stays behind, naming a pid that is gone
  const reclaimed = await race(lock, 6, 400);
  expect(reclaimed.filter(said => said === "held")).toHaveLength(1);
});

test("holds released and retaken in a crowd, with readers asking throughout, never overlap", async () => {
  const root = scratch(), lock = join(root, "pass.lock.sqlite"), trace = join(root, "trace");
  const until = Date.now() + 1_500;
  const taker = () => Bun.spawn([process.execPath, "-e", `const { tryHold } = await import(${JSON.stringify(module)});
    const { appendFileSync } = await import("node:fs");
    while (Date.now() < ${until}) {
      const hold = tryHold(process.env.LOCK);
      if (hold) { appendFileSync(process.env.TRACE, "in\\n"); await Bun.sleep(1); appendFileSync(process.env.TRACE, "out\\n"); hold.release(); hold.release(); }
      await Bun.sleep(Math.random() * 2);
    }`], { env: { ...process.env, LOCK: lock, TRACE: trace }, stderr: "inherit" });
  const reader = Bun.spawn([process.execPath, "-e", `const { isHeld } = await import(${JSON.stringify(module)});
    while (Date.now() < ${until}) isHeld(process.env.LOCK);`], { env: { ...process.env, LOCK: lock }, stderr: "inherit" });
  const children = [taker(), taker(), taker(), taker(), reader];
  cleanups.push(() => { for (const child of children) child.kill(9); });
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0, 0]);
  const lines = readFileSync(trace, "utf8").trim().split("\n");
  expect(lines.length).toBeGreaterThan(40);
  lines.forEach((line, i) => expect(line).toBe(i % 2 ? "out" : "in"));
}, 15_000);

test("an earlier version's lock directory is removed on the first hold", () => {
  const root = scratch(), retired = join(root, "pass.lock");
  mkdirSync(retired);
  writeFileSync(join(retired, "pid"), "999999999\n");
  tryHold(join(root, "pass.lock.sqlite"), { retired })!.release();
  expect(existsSync(retired)).toBe(false);
});

test("a hold whose record cannot be written still holds, and says once that it will read as idle", () => {
  const root = scratch(), lock = join(root, "pass.lock.sqlite");
  mkdirSync(join(root, "pass.lock.holder")); // a directory where the record goes: the write fails
  const warn = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let i = 0; i < 2; i++) {
      const hold = tryHold(lock)!;
      expect(hold).not.toBeNull();
      expect(tryHold(lock)).toBeNull();
      hold.release();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("reads as idle while held");
  } finally { warn.mockRestore(); }
});
