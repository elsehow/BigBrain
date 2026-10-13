import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitRunRecords, uncommittedRunRecords } from "../lib/runRecords";
import { gitVault, mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const vault = () => { const root = gitVault(); roots.push(root); return root; };
const put = (root: string, rel: string, text = "{}\n") => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();

test("a stage commits its run records as itself, and nothing flat beside them", () => {
  const root = vault();
  put(root, "journal/tend/2026-08/run-1.json");
  put(root, "journal/tend/door.json");
  put(root, "journal/feed/2026-08/call-1.json");
  expect(commitRunRecords(root, { dir: "journal/tend", role: "tend", summary: "tend: run run-1" })).toBe(true);
  expect(git(root, "log", "-1", "--format=%an|%s")).toBe("tend|tend: run run-1");
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("journal/tend/2026-08/run-1.json");
  // the trace and another stage's record are not tend's to commit
  expect(git(root, "status", "--porcelain", "-uall").split("\n").toSorted()).toEqual(["?? journal/feed/2026-08/call-1.json", "?? journal/tend/door.json"]);
  expect(commitRunRecords(root, { dir: "journal/tend", role: "tend", summary: "again" })).toBe(false);
});

test("a record whose commit failed rides the next", () => {
  const root = vault();
  put(root, "journal/feed/2026-08/call-1.json");
  // a concurrent writer holds the index
  writeFileSync(join(root, ".git", "index.lock"), "");
  expect(commitRunRecords(root, { dir: "journal/feed", role: "feed", summary: "feed: call-1" })).toBe(false);
  rmSync(join(root, ".git", "index.lock"));
  put(root, "journal/feed/2026-09/call-2.json");
  expect(commitRunRecords(root, { dir: "journal/feed", role: "feed", summary: "feed: call-2" })).toBe(true);
  expect(git(root, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(["journal/feed/2026-08/call-1.json", "journal/feed/2026-09/call-2.json"]);
});

test("an appending stage's own appends ride, and a record is never rewritten by one that is not", () => {
  const root = vault();
  put(root, "journal/gate/2026-08.jsonl", '{"id":"a"}\n');
  expect(commitRunRecords(root, { dir: "journal/gate", role: "gate", summary: "gate", appended: true })).toBe(true);
  appendFileSync(join(root, "journal/gate/2026-08.jsonl"), '{"id":"b"}\n');
  expect(uncommittedRunRecords(root, { dir: "journal/gate", appended: true })).toEqual(["journal/gate/2026-08.jsonl"]);
  expect(commitRunRecords(root, { dir: "journal/gate", role: "gate", summary: "gate", appended: true })).toBe(true);
  expect(git(root, "status", "--porcelain")).toBe("");
  // a one-record-per-run stage commits no modification: a record is written once
  put(root, "journal/tend/2026-08/run-1.json");
  commitRunRecords(root, { dir: "journal/tend", role: "tend", summary: "tend" });
  put(root, "journal/tend/2026-08/run-1.json", '{"changed":true}\n');
  expect(uncommittedRunRecords(root, { dir: "journal/tend" })).toEqual([]);
});

test("a vault that is not a repo records nothing, and says so quietly", () => {
  const root = mdVault(); roots.push(root);
  put(root, "journal/tend/2026-08/run-1.json");
  expect(commitRunRecords(root, { dir: "journal/tend", role: "tend", summary: "tend" })).toBe(false);
});
