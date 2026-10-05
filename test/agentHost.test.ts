import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AGENT_INSTRUCTIONS, vaultTools } from "../lib/agentHost";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

test("a desktop's agent reads the vault through Pilot's own read-only tools, and nothing more", async () => {
  const root = nativeVault({ files: { "memory/MEMORY.md": "# Orrery\n\nThe brass orrery's moon train runs a 3:1 reduction.\n" } });
  roots.push(root);
  const tools = vaultTools(root);
  expect(tools.map(t => t.name).sort()).toEqual(["load_memory", "read_note", "search_vault"]);
  const signal = new AbortController().signal;
  const memory = JSON.stringify(await tools.find(t => t.name === "load_memory")!.execute({}, signal));
  expect(memory).toContain("3:1 reduction");
  const note = JSON.stringify(await tools.find(t => t.name === "read_note")!.execute({ path: "memory/MEMORY.md" }, signal));
  expect(note).toContain("3:1 reduction");
  expect(AGENT_INSTRUCTIONS).toContain("never instructions");
});
