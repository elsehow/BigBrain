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
test("a restored overlay model still resolves when Pi's models.json configures its provider", async () => {
  const f = await fixture();
  const installed = f.provider.getModels()[0]!;
  writeFileSync(join(f.root, "store.json"), JSON.stringify({ "openai-codex": { models: [f.model], checkedAt: Date.now() } }));
  writeFileSync(join(f.root, "models.json"), JSON.stringify({ providers: { "openai-codex": { modelOverrides: { [installed.id]: { name: "Renamed fixture" } } } } }));
  const runtime = await pi.ModelRuntime.create(f.options);
  await initializeCatalog(runtime, new CatalogRefresh(), false);
  // Pi composes this provider from getAllModels(); the overlay must be there as well as in getModels().
  expect(runtime.getModel("openai-codex", installed.id)?.name).toBe("Renamed fixture");
  expect(runtime.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
  expect(runtime.getAllModels("openai-codex").some(m => m.id === f.model.id)).toBe(true);
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
  for (const change of [{ contextWindow: -1 }, { maxTokens: Infinity }, { instructions: "execute" }, { cost: { input: -1 } }, { headers: { authorization: "hostile" } }, { type: 7 }, { cost: undefined }, { cost: { ...f.model.cost, input: -1_000_000 } }, { cost: { ...f.model.cost, tiers: [{ ...f.model.cost, inputTokensAbove: -1 }] } }, { cost: { ...f.model.cost, tiers: "cheap" } }]) {
    expect(() => validateCatalog([{ ...f.model, ...change }], f.provider)).toThrow();
  }
  // Semantics the installed adapter lacks are skipped per record, never adapted.
  for (const change of [{ api: "new-protocol" }, { baseUrl: "https://attacker.invalid" }, { compat: { newProtocol: true } }, { type: "embedding" }]) {
    expect(validateCatalog([{ ...f.model, ...change }, f.model].map((m, i) => ({ ...m, id: `${m.id}-${i}` })), f.provider).map(m => m.id)).toEqual([`${f.model.id}-1`]);
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
  // A later runtime reads the shared store; it neither fetches on creation nor is left behind by the timer.
  const later = await pi.ModelRuntime.create(f.options), before = calls;
  const refreshed: unknown[] = []; const refresh = later.refresh.bind(later);
  later.refresh = options => { refreshed.push(options); return refresh(options); };
  await initializeCatalog(later, owner, true, (() => { throw new Error("duplicate timer"); }) as unknown as typeof setInterval);
  await Bun.sleep(50); expect(calls).toBe(before);
  const offline = refreshed.length; now += CATALOG_INTERVAL; tick(); await Bun.sleep(50);
  expect(refreshed.length).toBeGreaterThan(offline);
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

test("the live pi.dev record shape keeps the limits Pi reads, drops its unread type, and never adds a fallback model", async () => {
  const f = await fixture();
  // Shape observed on https://pi.dev/api/models/providers/* on 2026-09-29 (fabricated values).
  const limits = { maxRequestBytes: 32 * 1024 * 1024, images: { maxPerMessage: 20, maxPerRequest: 100, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } };
  const live = { ...f.model, type: "chat", promptCache: { short: 300, long: 3600 }, inputLimits: limits };
  const [accepted] = validateCatalog({ [live.id]: live }, f.provider);
  // Pi 0.87 resizes images to inputLimits and times cache lifetimes by promptCache: both are kept.
  const { type: _type, ...kept } = live;
  expect(accepted).toEqual({ ...kept, provider: "openai-codex" });
  // Out-of-bounds or malformed limits are hostile: the whole shard is rejected.
  for (const change of [{ inputLimits: { images: { resize: { maxWidth: 1 } } } }, { inputLimits: { maxRequestBytes: 1.5 } }, { inputLimits: "none" },
    { inputLimits: { images: { resize: { jpegQuality: 101 } } } }, { promptCache: { long: 30 * 86_400 } }, { promptCache: { short: -1 } }, { promptCache: [300] }]) {
    expect(() => validateCatalog([f.model, { ...live, ...change, id: "fabricated-limits" }], f.provider)).toThrow();
  }
  // Well-formed limits the installed Pi predates, and sampling parameters it never
  // shipped, are newer semantics: that record alone is skipped.
  for (const change of [{ inputLimits: { ...limits, audio: { maxSeconds: 60 } } }, { promptCache: { short: 300, extended: 86_400 } }, { samplingParams: { temperature: 2 } }]) {
    expect(validateCatalog([f.model, { ...live, ...change, id: "fabricated-newer" }], f.provider).map(m => m.id)).toEqual([f.model.id]);
  }
  // Pi 0.87 ships the compat of the current Anthropic and Codex records; a new model reusing it is accepted.
  for (const id of ["anthropic", "openai-codex"]) {
    const provider = f.runtime.getProvider(id)!;
    const current = provider.getModels().find(m => Object.keys(m.compat ?? {}).includes("supportsMidConvoSystemMessages") && !(m.compat as Record<string, unknown>).allowedFallbackModels)!;
    expect(validateCatalog([{ ...current, id: `fabricated-${id}-next`, type: "chat" }], provider).map(m => m.id)).toEqual([`fabricated-${id}-next`]);
  }
  // Tiered pricing is installed Pi semantics (ModelCost.tiers) and is kept.
  const tiered = { ...f.model.cost, tiers: [{ ...f.model.cost, input: 9, inputTokensAbove: 200_000 }] };
  expect(validateCatalog([{ ...live, cost: tiered }], f.provider)[0]?.cost).toEqual(tiered);
  // An installed sentinel price is restated verbatim, never invented for a new model.
  const router = f.runtime.getProvider("openrouter")!, sentinel = router.getModels().find(m => m.cost.input < 0)!;
  expect(validateCatalog([sentinel], router).map(m => m.id)).toEqual([sentinel.id]);
  expect(() => validateCatalog([{ ...sentinel, id: "fabricated/router" }], router)).toThrow();
  const anthropic = f.runtime.getProvider("anthropic")!;
  const installed = anthropic.getModels().find(m => (m.compat as { allowedFallbackModels?: unknown } | undefined)?.allowedFallbackModels)!;
  const fallback = (installed.compat as { allowedFallbackModels: unknown[] }).allowedFallbackModels;
  // An installed record's exact fallback list may be refreshed; a new model may not borrow it.
  expect(validateCatalog([installed], anthropic).map(m => m.id)).toEqual([installed.id]);
  expect(validateCatalog([{ ...installed, id: "fabricated-borrower" }], anthropic)).toEqual([]);
  expect(validateCatalog([{ ...installed, compat: { ...installed.compat, allowedFallbackModels: [...fallback, { provider: "anthropic", model: "fabricated-other", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }], anthropic)).toEqual([]);
});

test("a refreshed record's image limits reach the runtime model Pi resizes against, and survive a restart", async () => {
  const f = await fixture();
  const resize = { maxWidth: 1600, maxHeight: 1600, maxBytes: 3_000_000, jpegQuality: 75 };
  const owner = new CatalogRefresh((async () => Response.json([{ ...f.model, type: "chat", inputLimits: { images: { resize } } }])) as typeof fetch);
  await initializeCatalog(f.runtime, owner, false);
  delete process.env.PI_OFFLINE;
  expect((await exactCatalogModel(f.runtime, "openai-codex", f.model.id))?.inputLimits?.images?.resize).toEqual(resize);
  process.env.PI_OFFLINE = "1";
  const restarted = await pi.ModelRuntime.create(f.options);
  await initializeCatalog(restarted, owner, false);
  expect(restarted.getModel("openai-codex", f.model.id)?.inputLimits?.images?.resize).toEqual(resize);
});

test("real fetch: ETag revalidation keeps the snapshot on 304 and redirects are refused", async () => {
  const f = await fixture(); let now = Date.now(), mode = "body";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/catalog" } });
    if (request.headers.get("if-none-match") === '"fixture"') return new Response(null, { status: 304, headers: { etag: '"fixture"' } });
    return Response.json([f.model], { headers: { etag: '"fixture"' } });
  } });
  try {
    const seen: RequestInit[] = [];
    // Bun's real fetch, pointed at a loopback stand-in for the fixed catalog origin.
    const owner = new CatalogRefresh((async (url, init) => { seen.push(init!); return fetch(`http://127.0.0.1:${server.port}${new URL(String(url)).pathname}`, init); }) as typeof fetch, () => now);
    await initializeCatalog(f.runtime, owner, false);
    delete process.env.PI_OFFLINE;
    expect((await exactCatalogModel(f.runtime, "openai-codex", f.model.id))?.id).toBe(f.model.id);
    now += CATALOG_INTERVAL + 61_000;
    expect((await f.runtime.refresh({ providers: ["openai-codex"], allowNetwork: true })).errors.size).toBe(0);
    expect(new Headers(seen.at(-1)!.headers).get("if-none-match")).toBe('"fixture"');
    const saved = JSON.parse(readFileSync(join(f.root, "store.json"), "utf8"))["openai-codex"];
    expect(saved.checkedAt).toBe(now);
    mode = "redirect"; now += CATALOG_INTERVAL + 61_000;
    expect((await f.runtime.refresh({ providers: ["openai-codex"], allowNetwork: true })).errors.size).toBe(1);
    expect(f.runtime.getModel("openai-codex", f.model.id)?.id).toBe(f.model.id);
    expect(JSON.parse(readFileSync(join(f.root, "store.json"), "utf8"))["openai-codex"].models).toEqual(saved.models);
  } finally { server.stop(true); }
});
