import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { CATALOG_INTERVAL, CatalogRefresh, exactCatalogModel, initializeCatalog, validateCatalog } from "../lib/run/modelCatalogRefresh";
import { PiSession, type PiSDK } from "../lib/run/piSession";
import { piModels } from "../lib/modelCatalog";

const roots: string[] = [];
afterEach(() => { process.env.PI_OFFLINE = "1"; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catalog-")); roots.push(root);
  writeFileSync(join(root, "vault.yaml"), "auth: max\n");
  writeFileSync(join(root, "models.json"), "{}");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "fabricated", refresh: "fabricated", expires: Date.now() + 3600_000 }));
  const options = { credentials, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "store.json"), refreshOnCreate: false, allowModelNetwork: false };
  const runtime = await pi.ModelRuntime.create(options);
  const provider = runtime.getProvider("openai-codex")!;
  const model = { ...provider.getModels()[0]!, id: "fabricated-new-model", name: "Fabricated new model" };
  return { root, options, runtime, provider, model };
}
test("real initialization restores validated Pi persistence offline; malformed responses retain last good", async () => {
  const f = await fixture(); let now = Date.now(), body: unknown = [f.model], calls = 0;
  const owner = new CatalogRefresh((async () => { calls++; return Response.json(body); }) as typeof fetch, () => now);
  await initializeCatalog(f.runtime, owner, false);
  expect(f.runtime.getModel("openai-codex", f.model.id)).toBeUndefined();
  delete process.env.PI_OFFLINE;
  expect((await exactCatalogModel(f.runtime, "openai-codex", f.model.id))?.id).toBe(f.model.id);
  const saved = readFileSync(join(f.root, "store.json"), "utf8");
  body = [{ ...f.model, headers: { authorization: "hostile" } }]; now += CATALOG_INTERVAL;
  const failure = await f.runtime.refresh({ providers: ["openai-codex"], allowNetwork: true });
  expect(failure.errors.size).toBe(1);
  expect(readFileSync(join(f.root, "store.json"), "utf8")).toBe(saved);
  expect(f.runtime.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
  process.env.PI_OFFLINE = "1";
  const restarted = await pi.ModelRuntime.create(f.options);
  await initializeCatalog(restarted, owner, false);
  expect(restarted.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
  expect(calls).toBe(2);
});
test("concurrent exact misses coalesce, appear in shared discovery, and launch only the exact subscription model", async () => {
  const f = await fixture(); let calls = 0;
  const owner = new CatalogRefresh((async () => { calls++; await Bun.sleep(10); return Response.json([f.model]); }) as typeof fetch);
  await initializeCatalog(f.runtime, owner, false);
  delete process.env.PI_OFFLINE;
  const found = await Promise.all(Array.from({ length: 20 }, () => exactCatalogModel(f.runtime, "openai-codex", f.model.id)));
  expect(calls).toBe(1); expect(found.every(m => m?.id === f.model.id)).toBe(true);
  const load = async () => ({ ...pi, ModelRuntime: { create: async () => f.runtime } }) as unknown as PiSDK;
  const listed = await piModels(f.root, undefined, load);
  expect(listed.find(p => p.id === "pi/openai-codex")?.models.find(m => m.id === f.model.id)).toMatchObject({ availability: "unverified", adapterCompatibility: "installed-configuration" });
  const config = { adapter: "pi", provider: "openai-codex", model: f.model.id };
  const session = new PiSession({ root: f.root, config, instructions: "Synthetic fixture", tools: [], state: { through: 0 }, save() {} }, load);
  try {
    expect(await session.prepare()).toBe(true);
    expect(session.execution?.choice.model).toBe(f.model.id);
    expect(session.transport).toBe("subscription");
    expect(config.model).toBe(f.model.id);
  } finally { session.close(); }
  expect(await exactCatalogModel(f.runtime, "openai-codex", "still-unknown")).toBeUndefined();
  expect(calls).toBe(1);
});
test("actual PiSession and launch discovery refresh a miss before exact rejection", async () => {
  const f = await fixture(); let calls = 0;
  await initializeCatalog(f.runtime, new CatalogRefresh((async () => { calls++; return Response.json([f.model]); }) as typeof fetch), false);
  delete process.env.PI_OFFLINE;
  const load = async () => ({ ...pi, ModelRuntime: { create: async () => f.runtime } }) as unknown as PiSDK;
  const session = new PiSession({ root: f.root, config: { adapter: "pi", provider: "openai-codex", model: f.model.id }, instructions: "Fixture", tools: [], state: { through: 0 }, save() {} }, load);
  try { expect(await session.prepare()).toBe(true); expect(calls).toBe(1); } finally { session.close(); }
  expect((await piModels(f.root, { provider: "openai-codex", model: "unknown-exact" }, load)).find(p => p.id === "pi/openai-codex")?.models.some(m => m.id === "unknown-exact")).toBe(false);
  const missing = new PiSession({ root: f.root, config: { adapter: "pi", provider: "openai-codex", model: "unknown-exact" }, instructions: "Fixture", tools: [], state: { through: 0 }, save() {} }, load);
  await expect(missing.prepare()).rejects.toThrow("Choose an available model");
  expect(calls).toBe(1);
});
test("four-hour freshness and conditional revalidation; offline errors preserve exact models", async () => {
  const f = await fixture(); let now = Date.now(), calls = 0;
  const owner = new CatalogRefresh((async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json([f.model], { headers: { etag: '"fixture-v1"' } });
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"fixture-v1"');
    if (calls === 2) return new Response(null, { status: 304 });
    throw new Error("offline");
  }) as typeof fetch, () => now);
  await initializeCatalog(f.runtime, owner, false); delete process.env.PI_OFFLINE;
  const check = () => f.runtime.refresh({ providers: ["openai-codex"], allowNetwork: true });
  await check(); now += CATALOG_INTERVAL - 1; await check(); expect(calls).toBe(1);
  now++; await check(); expect(calls).toBe(2);
  now += CATALOG_INTERVAL; await check(); expect(calls).toBe(3);
  expect(f.runtime.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
});
test("hostile metadata, unsupported adapters, duplicates and corrupted persisted models fail closed", async () => {
  const f = await fixture();
  for (const change of [{ api: "new-protocol" }, { baseUrl: "https://attacker.invalid" }, { contextWindow: -1 }, { maxTokens: Infinity }, { instructions: "execute" }, { compat: { newProtocol: true } }, { cost: { input: -1 } }]) {
    expect(() => validateCatalog([{ ...f.model, ...change }], f.provider)).toThrow();
  }
  expect(() => validateCatalog([f.model, f.model], f.provider)).toThrow();
  writeFileSync(join(f.root, "store.json"), JSON.stringify({ "openai-codex": { models: [{ ...f.model, baseUrl: "https://attacker.invalid" }] } }));
  await initializeCatalog(f.runtime, new CatalogRefresh(), false);
  expect(f.runtime.getModel("openai-codex", f.model.id)).toBeUndefined();
  expect(f.runtime.getModels("openai-codex").length).toBeGreaterThan(0);
});
test("startup is nonblocking and installs a four-hour revalidation task", async () => {
  const f = await fixture(); let release!: () => void, calls = 0, tick!: () => void, now = Date.now();
  const gate = new Promise<void>(resolve => { release = resolve; });
  const owner = new CatalogRefresh((async () => { calls++; await gate; return Response.json([]); }) as typeof fetch, () => now);
  delete process.env.PI_OFFLINE;
  await initializeCatalog(f.runtime, owner, true, ((callback: () => void, ms: number) => {
    expect(ms).toBe(CATALOG_INTERVAL); tick = callback;
    return { unref() {} };
  }) as unknown as typeof setInterval);
  expect(f.runtime.getModels("openai-codex").length).toBeGreaterThan(0);
  await Bun.sleep(10); expect(calls).toBeGreaterThan(0);
  release(); await Bun.sleep(50);
  const initialCalls = calls; now += CATALOG_INTERVAL; tick();
  for (let i = 0; i < 100 && calls === initialCalls; i++) await Bun.sleep(10);
  expect(calls).toBeGreaterThan(initialCalls);
  await Bun.sleep(100);
  // Repeated startup does not install another timer or block on the transport.
  await initializeCatalog(f.runtime, owner, true, (() => { throw new Error("duplicate timer"); }) as unknown as typeof setInterval);
});
test("invalid JSON, oversized bodies, HTTP failures and stalled transport never publish", async () => {
  const f = await fixture();
  for (const transport of [
    async () => new Response("{"),
    async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
    async () => new Response("unavailable", { status: 503 }),
    async () => new Promise<Response>(() => {}),
  ]) {
    const runtime = await pi.ModelRuntime.create(f.options);
    await initializeCatalog(runtime, new CatalogRefresh(transport as typeof fetch, Date.now, 20), false);
    delete process.env.PI_OFFLINE;
    const before = runtime.getModels("openai-codex").map(m => m.id);
    const result = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: true });
    expect(result.errors.size).toBe(1);
    expect(runtime.getModels("openai-codex").map(m => m.id)).toEqual(before);
  }
});
test("launch_agent preflight discovers a new exact model instead of rejecting or substituting it", async () => {
  const { AgentOrchestrator } = await import("../lib/agentOrchestrator");
  const { PilotChats } = await import("../lib/pilotChat");
  const f = await fixture(); let calls = 0;
  await initializeCatalog(f.runtime, new CatalogRefresh((async () => { calls++; return Response.json([f.model]); }) as typeof fetch), false);
  const load = async () => ({ ...pi, ModelRuntime: { create: async () => f.runtime } }) as unknown as PiSDK;
  const agents = new AgentOrchestrator(f.root), chats = new PilotChats(f.root, { external: agents, graph: () => [] });
  try {
    chats.models = requested => piModels(f.root, requested, load);
    const pilot = chats.create([]), signal = new AbortController().signal;
    const invoke = (name: string, args: unknown) => (chats as any).executeTool(chats.get(pilot.id), name, args, signal);
    expect((await invoke("list_agent_models", {})).agents.find((p: any) => p.id === "pi/openai-codex").models.some((m: any) => m.id === f.model.id)).toBe(false);
    delete process.env.PI_OFFLINE;
    const model = { adapter: "pi", provider: "openai-codex", model: f.model.id };
    const project = mkdtempSync(join(tmpdir(), "catalog-project-")); roots.push(project);
    const args = { title: "Fixture review", task: "Inspect fixture", context: "Synthetic context", cwd: project, model };
    expect(await invoke("launch_agent", args)).toMatchObject({ status: "needs-input", model });
    expect(calls).toBe(1);
    expect(await invoke("launch_agent", { ...args, model: { ...model, model: "not-present" } })).toMatchObject({ error: expect.stringContaining("not connected or available") });
    expect(agents.list()).toHaveLength(1);
  } finally { chats.close(); agents.close(); }
});
test("different runtime accounts share public metadata, never configured auth or entitlement", async () => {
  const f = await fixture(); let calls = 0;
  const owner = new CatalogRefresh((async () => { calls++; await Bun.sleep(10); return Response.json([f.model]); }) as typeof fetch);
  const otherCredentials = new InMemoryCredentialStore();
  await otherCredentials.modify("openai-codex", async () => ({ type: "oauth", access: "different-fixture", refresh: "different-fixture", expires: Date.now() + 3600_000 }));
  const other = await pi.ModelRuntime.create({ ...f.options, credentials: otherCredentials });
  await Promise.all([initializeCatalog(f.runtime, owner, false), initializeCatalog(other, owner, false)]);
  delete process.env.PI_OFFLINE;
  const results = await Promise.all([f.runtime, other].map(runtime => exactCatalogModel(runtime, "openai-codex", f.model.id)));
  expect(results.map(m => m?.id)).toEqual([f.model.id, f.model.id]); expect(calls).toBe(1);
  expect(f.runtime.getAvailableSnapshot().some(m => m.id === f.model.id)).toBe(true);
  process.env.PI_OFFLINE = "1";
  const disconnected = await pi.ModelRuntime.create({ ...f.options, credentials: new InMemoryCredentialStore() });
  await initializeCatalog(disconnected, owner, false);
  expect(disconnected.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
  expect(disconnected.getAvailableSnapshot().some(m => m.id === f.model.id)).toBe(false);
});
