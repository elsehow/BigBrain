import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireWorkerWorkspaces } from "../lib/legacy";
import { pruneSessionScratch } from "../lib/scratchPrune";

const DAY = 86_400_000, NOW = Date.parse("2026-10-30T00:00:00Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const vault = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bb-prune-"));
  roots.push(root);
  mkdirSync(join(root, ".spool", "workspaces"), { recursive: true });
  mkdirSync(join(root, ".spool", "pilot-chats"), { recursive: true });
  return root;
};
const id = (c: string, kind = "pilot") => `${kind}-${c.repeat(32)}`;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
/** A session's scratch, with a file in it, and its record when `saved` is given. */
function session(root: string, name: string, saved?: Record<string, unknown>, touchedDaysAgo = 0): string {
  const dir = join(root, ".spool", "workspaces", name);
  mkdirSync(dir);
  writeFileSync(join(dir, "notes.md"), "a handoff");
  const at = new Date(NOW - touchedDaysAgo * DAY);
  utimesSync(dir, at, at);
  if (saved) writeFileSync(join(root, ".spool", "pilot-chats", `${name}.json`), JSON.stringify({ id: name, ...saved }));
  return dir;
}

describe("pruneSessionScratch", () => {
  test("an archived session's scratch goes once it has been idle long enough; anything still live stays", () => {
    const root = vault();
    const archived = { deactivatedAt: ago(20), lifecycle: "ingested", lastActivityAt: ago(20) };
    const gone = session(root, id("a"), archived);
    const recent = session(root, id("b"), { ...archived, lastActivityAt: ago(3) });
    const closed = session(root, id("c"), { deactivatedAt: ago(20), lifecycle: "dormant", lastActivityAt: ago(20) });
    const open = session(root, id("d"), { lifecycle: "active", lastActivityAt: ago(20) });
    const running = session(root, id("e"), { ...archived, turn: { id: "t", status: "running" } });
    expect(pruneSessionScratch(root, { now: NOW }).removed).toEqual([id("a")]);
    expect([gone, recent, closed, open, running].map(existsSync)).toEqual([false, true, true, true, true]);
  });

  test("scratch no session names goes once it has sat as long, the retired workers' included", () => {
    const root = vault();
    const old = session(root, id("f", "work"), undefined, 30), fresh = session(root, id("0"), undefined, 1);
    expect(pruneSessionScratch(root, { now: NOW }).removed).toEqual([id("f", "work")]);
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
  });

  test("a session whose record can't be read keeps its scratch", () => {
    const root = vault(), kept = session(root, id("7"), undefined, 30);
    writeFileSync(join(root, ".spool", "pilot-chats", `${id("7")}.json`), "{ not json");
    expect(pruneSessionScratch(root, { now: NOW }).removed).toEqual([]);
    expect(existsSync(kept)).toBe(true);
  });

  test("only scratch folders, never through a link", () => {
    const root = vault(), outside = mkdtempSync(join(tmpdir(), "bb-prune-outside-"));
    roots.push(outside);
    const stray = session(root, "notes", undefined, 30);
    symlinkSync(outside, join(root, ".spool", "workspaces", id("9")));
    expect(pruneSessionScratch(root, { now: NOW }).removed).toEqual([]);
    expect([existsSync(stray), existsSync(outside)]).toEqual([true, true]);
  });

  test("a vault with no scratch has nothing to prune", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-prune-empty-"));
    roots.push(root);
    expect(pruneSessionScratch(root, { now: NOW }).removed).toEqual([]);
  });
});

describe("retireWorkerWorkspaces", () => {
  test("the retired workers' scratch is removed, once", () => {
    const root = vault(), dir = join(root, ".spool", "worker-workspaces", id("1", "work"), "scratch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "big.bin"), "x");
    expect(retireWorkerWorkspaces(root)).toBe("removed");
    expect(existsSync(join(root, ".spool", "worker-workspaces"))).toBe(false);
    expect(retireWorkerWorkspaces(root)).toBe("none");
  });
});
