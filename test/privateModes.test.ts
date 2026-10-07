/** Credential files and the folders that hold them are owner-only when the
 * engine creates them, and an older install's looser modes are tightened. */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, makePrivate, writeAtomic } from "../lib/fsx";
import { writeExample } from "../lib/themes";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const mode = (path: string) => statSync(path).mode & 0o777;

test("a private file's missing parent folders are created owner-only", () => {
  const dir = scratch("bb-private-modes-");
  writeAtomic(join(dir, "config", "tokens", "store.json"), "{}\n", 0o600);
  expect([mode(join(dir, "config")), mode(join(dir, "config", "tokens")), mode(join(dir, "config", "tokens", "store.json"))]).toEqual([0o700, 0o700, 0o600]);
  ensureDir(join(dir, "logs", "nested"), 0o700);
  expect([mode(join(dir, "logs")), mode(join(dir, "logs", "nested"))]).toEqual([0o700, 0o700]);
  writeExample(join(dir, "themes"));
  expect(mode(join(dir, "themes"))).toBe(0o700);
});

test("makePrivate clears group and other bits once, keeps the owner's, and ignores a missing path", () => {
  const dir = scratch("bb-private-modes-"), folder = join(dir, "config"), file = join(dir, ".env");
  mkdirSync(folder); chmodSync(folder, 0o755); writeFileSync(file, "KEY=invented\n"); chmodSync(file, 0o644);
  expect([makePrivate(folder), makePrivate(file)]).toEqual([true, true]);
  expect([mode(folder), mode(file)]).toEqual([0o700, 0o600]);
  expect([makePrivate(folder), makePrivate(file), makePrivate(join(dir, "missing"))]).toEqual([false, false, false]);
});

test("a new vault's config dir, pointer, .env and logs are owner-only", () => {
  const home = scratch("bb-private-home-"), vault = join(home, "invented-vault");
  const script = `import { createVault, pointAt } from ${JSON.stringify(resolve("lib/firstRun.ts"))}; pointAt(createVault(${JSON.stringify(vault)}, ${JSON.stringify(resolve("."))}));`;
  const identity = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test" };
  const result = spawnSync(process.execPath, ["-e", script], { cwd: home, encoding: "utf8", timeout: 60_000, env: { HOME: home, PATH: process.env.PATH, TMPDIR: home, ...identity } });
  if (result.status !== 0) throw new Error(result.stderr);
  const config = join(home, ".config", "bigbrain");
  expect([mode(config), mode(join(config, "vault")), mode(join(vault, ".env")), mode(join(vault, ".state", "logs"))]).toEqual([0o700, 0o600, 0o600, 0o700]);
}, 60_000);
