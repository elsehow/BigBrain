import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeWorkPermissions, readWorkPermissions, saveWorkPermissions } from "../lib/workPermissions";
import { writeEnvValues } from "../lib/envFile";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "bb-permissions-")); roots.push(root); return root; }
test("default is restricted; settings resolve directory aliases and survive reload", () => {
  const root = fixture(), project = join(root, "project"); mkdirSync(project); symlinkSync(project, join(root, "alias"));
  expect(readWorkPermissions(root)).toEqual({ version: 2, folders: [] });
  const permissions = normalizeWorkPermissions({ directories: [project, join(root, "alias")], cowboy: false });
  expect(permissions.folders).toHaveLength(1);
  saveWorkPermissions(root, permissions); expect(readWorkPermissions(root)).toEqual(permissions);
  expect(() => saveWorkPermissions(root, { ...permissions, cowboy: true })).toThrow("read access");
  writeEnvValues(root, { BIGBRAIN_PILOT_AGENT_PERMISSIONS: JSON.stringify({ directories: [project], cowboy: true }) });
  expect(readWorkPermissions(root)).toMatchObject({ version: 2, legacyCowboy: true });
});
test("malformed settings and missing directories fail closed", () => {
  const root = fixture();
  expect(() => normalizeWorkPermissions({ cowboy: "true", directories: [] })).toThrow();
  expect(() => normalizeWorkPermissions({ cowboy: false, directories: ["relative"] })).toThrow();
  expect(() => normalizeWorkPermissions({ cowboy: false, directories: [join(root, "missing")] })).toThrow();
  writeEnvValues(root, { BIGBRAIN_PILOT_AGENT_PERMISSIONS: "invalid" });
  expect(() => readWorkPermissions(root)).toThrow();
});

test("symlinks cannot expand saved directory access, including paths to new files", async () => {
  const { withinWorkDirectories, validatedWorkPermissions } = await import("../lib/workPermissions");
  const root = fixture(), inside = join(root, "inside"), outside = join(root, "outside"); mkdirSync(inside); mkdirSync(outside);
  symlinkSync(outside, join(inside, "escape"));
  const p = normalizeWorkPermissions({ directories: [inside], cowboy: false }); saveWorkPermissions(root, p);
  expect(withinWorkDirectories(join(inside, "new.txt"), p.folders.map(f => f.path))).toBe(true);
  expect(withinWorkDirectories(join(inside, "escape", "new.txt"), p.folders.map(f => f.path))).toBe(false);
  rmSync(inside, { recursive: true }); symlinkSync(outside, inside);
  expect(() => validatedWorkPermissions(root)).toThrow("changed location");
});

test("Settings accepts the same home shorthand advertised by its folder input", async () => {
  const { homedir } = await import("node:os");
  const { realpathSync } = await import("node:fs");
  const settings = normalizeWorkPermissions({ version: 2, folders: [{ path: "~", access: "read" }] });
  expect(settings.folders).toEqual([{ path: realpathSync(homedir()), access: "read" }]);
});
