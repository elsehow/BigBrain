/** integrationRegistry.test.ts — the declarations every integration makes
 * (lib/integrations/) stay loadable and unambiguous. */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { INTEGRATIONS, integrationTool } from "../lib/integrations";
import { VAULT_TOOLS } from "../lib/vaultTools";

test("each integration module loads on its own, before the registry that lists it", () => {
  // an integration that reaches back to the registry at load finds it half-built
  const dir = join(import.meta.dir, "../lib/integrations");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
    const run = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(join(dir, file))}); const { INTEGRATIONS } = await import(${JSON.stringify(join(dir, "index.ts"))}); if (!INTEGRATIONS.every(Boolean)) process.exit(3);`]);
    expect({ file, code: run.exitCode, stderr: run.stderr.toString().slice(0, 400) }).toEqual({ file, code: 0, stderr: "" });
  }
});

test("a tool name means one tool", () => {
  const names = INTEGRATIONS.flatMap(i => i.tools.map(t => t.name));
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(VAULT_TOOLS.some(t => t.name === name) || name === "integration_capabilities").toBe(false);
  expect(new Set(INTEGRATIONS.map(i => i.id)).size).toBe(INTEGRATIONS.length);
  for (const i of INTEGRATIONS) for (const t of i.tools) expect(integrationTool(t.name)).toEqual({ integration: i, tool: t });
});

test("only an integration with live tools describes live access", () => {
  for (const i of INTEGRATIONS) {
    expect(!!i.live).toBe(i.tools.length > 0);
    if (i.live) expect(i.live.write !== null).toBe(i.tools.some(t => t.access === "write"));
  }
});
