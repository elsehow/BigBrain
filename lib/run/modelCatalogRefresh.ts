/** Data-only Pi catalog overlays. Pi still owns models, auth, and locked persistence.
 * Remote records may reuse installed adapter configurations, never install code or
 * invent credential destinations. Catalog membership is NOT account entitlement. */
import { configureVaultModelAuth } from "./piModelRuntime";
import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CreateModelRuntimeOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";

export const CATALOG_INTERVAL = 4 * 60 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;
const keys = new Set(["id", "name", "provider", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat", "thinkingLevelMap", "headers"]);
// Newer pi.dev metadata that the installed adapters never read: dropping it is
// exactly what the installed runtime does with it.
const descriptive = new Set(["type", "inputLimits", "promptCache"]);
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const text = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rates = (c: unknown, extra: string[] = []) => !!c && typeof c === "object" && !Array.isArray(c)
  && Object.keys(c).sort().join() === ["cacheRead", "cacheWrite", "input", "output", ...extra].sort().join() && Object.values(c).every(finite);
// Pi prices a request by its highest matching input tier (ModelCost.tiers).
const validCost = (c: unknown) => { if (!c || typeof c !== "object") return false; const { tiers, ...base } = c as { tiers?: unknown };
  return rates(base) && (tiers === undefined || Array.isArray(tiers) && tiers.length <= 16 && tiers.every(t => rates(t, ["inputTokensAbove"]))); };
/** Hostile or malformed records reject the whole shard (last good stays). Records the
 * installed adapter cannot serve as published are skipped one by one, never adapted. */
export function validateCatalog(value: unknown, provider: Provider): Model<Api>[] {
  const entries = Array.isArray(value) ? value : value && typeof value === "object"
    ? ("models" in value ? value.models : Object.values(value)) : undefined;
  if (!Array.isArray(entries) || entries.length > 5000) throw new Error("Invalid catalog");
  const baseline = provider.getModels(), ids = new Set<string>();
  return entries.flatMap(record => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid catalog model");
    const m = Object.fromEntries(Object.entries(record).filter(([k]) => !descriptive.has(k))) as Record<string, any>;
    // Installed sentinel prices (e.g. a router's variable-price marker) may be restated verbatim.
    const installed = typeof m.id === "string" ? baseline.find(b => b.id === m.id) : undefined;
    if (Object.keys(m).some(k => !keys.has(k)) || !text(m.id) || !text(m.name)
      || ids.has(m.id) || (m.provider !== undefined && m.provider !== provider.id)
      || ("type" in record && typeof record.type !== "string")
      || typeof m.reasoning !== "boolean" || !Array.isArray(m.input) || !m.input.length || m.input.some((v: unknown) => v !== "text" && v !== "image")
      || !Number.isSafeInteger(m.contextWindow) || m.contextWindow <= 0 || !Number.isSafeInteger(m.maxTokens) || m.maxTokens <= 0
      || !(validCost(m.cost) || !!installed && equal(installed.cost, m.cost))) throw new Error("Invalid catalog model");
    // Remote headers never enter a runtime model: only an installed record's exact headers.
    if (m.headers !== undefined && !baseline.some(b => b.headers && equal(b.headers, m.headers))) throw new Error("Invalid catalog model");
    ids.add(m.id);
    if ("type" in record && record.type !== "chat") return [];
    // A server-side fallback serves a different model than the one chosen: a remote
    // record may keep the installed record's exact list, never introduce one.
    if (m.compat?.allowedFallbackModels !== undefined && !equal((installed?.compat as Record<string, unknown> | undefined)?.allowedFallbackModels, m.compat.allowedFallbackModels)) return [];
    // Unknown protocol/configuration semantics require an adapter release. Never
    // infer compatibility from a model name or copy remote headers/instructions.
    if (!baseline.some(b => b.api === m.api && b.baseUrl === m.baseUrl
      && equal(b.compat, m.compat) && equal(b.thinkingLevelMap, m.thinkingLevelMap))) return [];
    return [{ ...m, provider: provider.id } as Model<Api>];
  });
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One bounded fetch per provider per process, including concurrent launch misses.
 * Failure cooldown prevents typo/offline storms; it does not overwrite last-good. */
export class CatalogRefresh {
  private timer?: ReturnType<typeof setInterval>;
  private latest?: ModelRuntime;
  /** One revalidation per process start, then every four hours, always of the newest runtime:
   * runtimes share Pi's persisted store, so each new one needs no network pass of its own. */
  start(runtime: ModelRuntime, schedule = setInterval): void {
    this.latest = runtime;
    if (this.timer) return;
    const revalidate = () => { const current = this.latest; if (current) void refreshRuntime(current, { providers: publicProviders, allowNetwork: true, signal: AbortSignal.timeout(5000) }).catch(() => {}); };
    revalidate();
    this.timer = schedule(revalidate, CATALOG_INTERVAL); this.timer.unref?.();
  }
  private requests = new Map<string, { at: number; promise: Promise<ModelsStoreEntry> }>();
  constructor(private transport: typeof fetch = fetch, private now = Date.now, private timeoutMs = 4000) {}
  private request(provider: Provider, stored?: ModelsStoreEntry): Promise<ModelsStoreEntry> {
    const previous = this.requests.get(provider.id);
    if (previous && this.now() - previous.at < 60_000) return previous.promise;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const promise = untilAborted((async () => {
      const response = await this.transport(`https://pi.dev/api/models/providers/${encodeURIComponent(provider.id)}`, {
        // Bun's fetch treats a 304 as a redirect under "error"; refuse real redirects below.
        signal, redirect: "manual", credentials: "omit",
        headers: { accept: "application/json", ...(stored?.etag ? { "if-none-match": stored.etag } : {}) },
      });
      if (response.status === 304 && stored) return { ...stored, checkedAt: this.now() };
      if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) throw new Error("Catalog redirect refused");
      if (!response.ok || !response.body) throw new Error("Catalog unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > MAX_BYTES) throw new Error("Catalog too large"); chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const models = validateCatalog(JSON.parse(new TextDecoder().decode(bytes)), provider);
      const etag = response.headers.get("etag");
      return { models, checkedAt: this.now(), ...(etag && etag.length < 1024 ? { etag } : {}) };
    })(), signal);
    this.requests.set(provider.id, { at: this.now(), promise });
    return promise;
  }
  wrap(provider: Provider): Provider {
    const baseline = [...provider.getModels()]; let models = baseline;
    const trusted = { ...provider, getModels: () => baseline };
    return { ...provider, getModels: () => models, refreshModels: async context => {
      let stored: ModelsStoreEntry | undefined;
      try {
        if (context.stored) stored = { ...context.stored, models: validateCatalog(context.stored.models, trusted) };
      } catch { /* Corrupt/untrusted disk overlay: use installed models. */ }
      const publish = async (entry: ModelsStoreEntry, persist: boolean) => {
        const overlay = validateCatalog(entry.models, trusted);
        const merged = new Map(baseline.map(m => [m.id, m]));
        for (const model of overlay) merged.set(model.id, model);
        if (!context.signal.aborted) await context.publish({ ...(persist ? { persist: entry } : {}), update: () => { models = [...merged.values()]; } });
      };
      if (stored) await publish(stored, false);
      if (!context.allowNetwork || process.env.PI_OFFLINE !== undefined || context.signal.aborted) return;
      if (!context.force && stored?.checkedAt && this.now() - stored.checkedAt >= 0 && this.now() - stored.checkedAt < CATALOG_INTERVAL) return;
      await publish(await this.request(trusted, stored), true);
    } };
  }
}
const publicProviders = builtinProviders().filter(p => p.id !== "radius").map(p => p.id);
const activeRefreshes = new WeakMap<ModelRuntime, Promise<unknown>>();
function refreshRuntime(runtime: ModelRuntime, options: Parameters<ModelRuntime["refresh"]>[0]) {
  const previous = activeRefreshes.get(runtime) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => runtime.refresh(options));
  activeRefreshes.set(runtime, pending);
  void pending.finally(() => { if (activeRefreshes.get(runtime) === pending) activeRefreshes.delete(runtime); }).catch(() => {});
  return pending;
}
const refresh = new CatalogRefresh();
const initialized = new WeakMap<ModelRuntime, Promise<ModelRuntime>>();
const pendingMisses = new WeakMap<ModelRuntime, Map<string, Promise<unknown>>>();
export function initializeCatalog(runtime: ModelRuntime, owner = refresh, background = true, schedule = setInterval, signal = AbortSignal.timeout(10_000), root?: string): Promise<ModelRuntime> {
  const existing = initialized.get(runtime);
  if (existing) return existing;
  const pending = (async () => {
    // Pi registration starts fire-and-forget offline refreshes. Drain every one
    // before the final snapshot: models.json reads can finish out of order and
    // otherwise supersede (abort) the initialization/first launch refresh.
    const originalRefresh = runtime.refresh;
    const registrations: ReturnType<ModelRuntime["refresh"]>[] = [];
    runtime.refresh = options => {
      const work = originalRefresh.call(runtime, options);
      registrations.push(work);
      return work;
    };
    try {
      for (const provider of builtinProviders()) {
        if (provider.id !== "radius") runtime.registerNativeProvider(owner.wrap(provider));
      }
    } finally { runtime.refresh = originalRefresh; }
    await untilAborted(Promise.allSettled(registrations), signal);
    await runtime.refresh({ allowNetwork: false, signal });
    signal.throwIfAborted();
    if (root) await configureVaultModelAuth(runtime, root);
    if (background) owner.start(runtime, schedule);
    return runtime;
  })();
  initialized.set(runtime, pending);
  void pending.catch(() => initialized.delete(runtime));
  return pending;
}
export async function createCatalogRuntime(sdk: { ModelRuntime: { create(options: CreateModelRuntimeOptions): Promise<ModelRuntime> } }, signal?: AbortSignal, root?: string): Promise<ModelRuntime> {
  return initializeCatalog(await sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, signal }), refresh, true, setInterval, signal, root);
}
export async function exactCatalogModel(runtime: ModelRuntime, provider: string, id: string, signal?: AbortSignal) {
  let model = runtime.getModel(provider, id);
  if (!model && publicProviders.includes(provider)) {
    let misses = pendingMisses.get(runtime);
    if (!misses) { misses = new Map(); pendingMisses.set(runtime, misses); }
    let pending = misses.get(provider);
    if (!pending) {
      pending = refreshRuntime(runtime, { providers: [provider], force: true, allowNetwork: true, signal: AbortSignal.timeout(5000) })
        .finally(() => { misses!.delete(provider); });
      misses.set(provider, pending);
    }
    await untilAborted(pending, signal ?? AbortSignal.timeout(5000));
    signal?.throwIfAborted();
    model = runtime.getModel(provider, id);
  }
  return model;
}
