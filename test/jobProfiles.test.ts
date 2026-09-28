import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./support/vault";
import { jobProfile } from "../lib/run/jobProfiles";
import { machineTools } from "../lib/run/machineTools";
import { readModelChoice, modelRole } from "../lib/modelChoice";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("fixed job profiles fail closed and cannot turn Quick or a fold into a writer", () => {
  expect(jobProfile("quick", "none").tools).toBe("none");
  expect(jobProfile("memory", "none").tools).toBe("none");
  for (const [role, capabilities] of [["quick", "memory"], ["memory", "gardener"], ["invented", "none"], ["pilot", "memory"]] as const)
    expect(() => jobProfile(role, capabilities)).toThrow("profile");
  expect(() => modelRole("invented")).toThrow("Unknown");
  const root = nativeVault(); roots.push(root);
  expect(machineTools(root, "tend").map(t => t.name)).toEqual(["search_vault", "read_note", "next", "open", "submit", "read_intake"]);
  expect(() => machineTools(root, "invented")).toThrow("profile");
});
test("memory rejects hard links as well as traversal before reads or writes", () => {
  const root = nativeVault(); roots.push(root);
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "private.txt"), "synthetic protected content");
  linkSync(join(root, "private.txt"), join(root, "memory", "linked.md"));
  const tools = machineTools(root, "memory");
  for (const name of ["read_file", "write_memory", "delete_memory"])
    expect(() => tools.find(t => t.name === name)!.call({ path: "memory/linked.md", content: "replacement" })).toThrow("hard-linked");
});
test("saved Claude aliases migrate to native Pi identity without silently changing providers", () => {
  expect(readModelChoice({ adapter: "claude", model: "sonnet", reasoning: "high" })).toEqual({ adapter: "pi", provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" });
  expect(readModelChoice({ adapter: "claude", model: "claude-sonnet-4-6" }).model).toBe("claude-sonnet-4-6");
});
