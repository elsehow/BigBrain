import { createCatalogRuntime, exactCatalogModel } from "./run/modelCatalogRefresh";
import { SUBSCRIPTION_PROVIDERS } from "./providerConnection";
import { providerLabel } from "./providerPresentation";
/** Read-only provider discovery shared by Pilot menus and curation settings. */
import { loadPi } from "./run/piSession";
import type { SetupState } from "./firstRun";
import { sessionCapabilities, type ModelCapabilities } from "./modelChoice";
export interface AgentModel { availability?: "unverified"; adapterCompatibility?: "installed-configuration"; id: string; label: string; isDefault?: boolean; reasoning?: string[]; defaultReasoning?: string }

export interface ModelProvider { authentication?: "configured" | "missing"; entitlement?: "unverified"; id: string; label: string; ready: boolean; models: (AgentModel & { capabilities?: Partial<ModelCapabilities> })[]; capabilities?: Partial<ModelCapabilities>; problem?: string; billing?: "subscription" | "api" }
export type CurationAgent = ModelProvider;
export interface ModelSources { pi: (root?: string) => Promise<ModelProvider[]> }
const sources: ModelSources = { pi: piModels };

/** Each provider is queried once. Discovery never changes saved preferences. */
export async function modelCatalog(state: SetupState, read: ModelSources = sources): Promise<ModelProvider[]> {
  try { return await read.pi(state.vault?.path); }
  catch { return Object.values(SUBSCRIPTION_PROVIDERS).map(p => ({ id: `pi/${p.providerId}`, label: p.label, ready: false, models: [], problem: `Could not load ${p.label} models. Retry discovery.` })); }
}
export async function pilotModels(root: string, requested?: { provider?: string; model: string }): Promise<ModelProvider[]> {
  const { setupState } = await import("./firstRun");
  return modelCatalog(setupState(root), { pi: root => piModels(root, requested) });
}
/** Compatibility endpoint; all roles consume exactly the same provider catalog. */
export const curationModels = modelCatalog;
export async function piModels(root?: string, requested?: { provider?: string; model: string }, load = loadPi): Promise<ModelProvider[]> {
  const sdk = await load();
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai/compat");
  const runtime = await createCatalogRuntime(sdk, AbortSignal.timeout(10_000), root);
  if (requested?.provider) await exactCatalogModel(runtime, requested.provider, requested.model);
  const available = runtime.getAvailableSnapshot();
  return runtime.getProviders().filter(p => (p.id === "anthropic" || p.id === "openai-codex" || available.some(m => m.provider === p.id))).map(p => {
    const models = available.filter(m => m.provider === p.id && (p.id !== "anthropic" || runtime.isUsingSubscription(p.id)));
    return { id: `pi/${p.id}`, label: (p.id === "openai-codex" || p.id === "anthropic") ? providerLabel(p.id) : `${p.name} via Pi`, ready: models.length > 0,
      authentication: runtime.hasConfiguredAuth(p.id) ? "configured" as const : "missing" as const, entitlement: "unverified" as const,
      capabilities: sessionCapabilities("pi", runtime.isUsingSubscription(p.id) ? "subscription" : "api"),
      billing: runtime.isUsingSubscription(p.id) ? "subscription" as const : "api" as const,
      models: models.map(m => ({ id: m.id, label: m.name, availability: "unverified" as const, adapterCompatibility: "installed-configuration" as const, reasoning: getSupportedThinkingLevels(m),
        capabilities: (m as typeof m & { capabilities?: Partial<ModelCapabilities> }).capabilities })),
      // An ordinary disconnection is availability, not a failed discovery.
      // Role selection supplies the shared connection guidance.
    };
  });
}
