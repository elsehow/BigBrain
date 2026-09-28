import { configureVaultModelAuth } from "./run/piModelRuntime";
import { SUBSCRIPTION_PROVIDERS } from "./providerConnection";
import { providerLabel } from "./providerPresentation";
/** Read-only provider discovery shared by Pilot menus and curation settings. */
import { loadPi } from "./run/piSession";
import type { SetupState } from "./firstRun";
import { sessionCapabilities, type ModelCapabilities } from "./modelChoice";
export interface AgentModel { id: string; label: string; isDefault?: boolean; reasoning?: string[]; defaultReasoning?: string }

export interface ModelProvider { id: string; label: string; ready: boolean; models: (AgentModel & { capabilities?: Partial<ModelCapabilities> })[]; capabilities?: Partial<ModelCapabilities>; problem?: string; billing?: "subscription" | "api" }
export type CurationAgent = ModelProvider;
export interface ModelSources { pi: (root?: string) => Promise<ModelProvider[]> }
const sources: ModelSources = { pi: piModels };

/** Each provider is queried once. Discovery never changes saved preferences. */
export async function modelCatalog(state: SetupState, read: ModelSources = sources): Promise<ModelProvider[]> {
  try { return await read.pi(state.vault?.path); }
  catch { return Object.values(SUBSCRIPTION_PROVIDERS).map(p => ({ id: `pi/${p.providerId}`, label: p.label, ready: false, models: [], problem: `Could not load ${p.label} models. Retry discovery.` })); }
}
export async function pilotModels(root: string): Promise<ModelProvider[]> {
  const { setupState } = await import("./firstRun");
  return modelCatalog(setupState(root));
}
/** Compatibility endpoint; all roles consume exactly the same provider catalog. */
export const curationModels = modelCatalog;
async function piModels(root?: string): Promise<ModelProvider[]> {
  const sdk = await loadPi();
  const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai/compat");
  const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(10_000) });
  await configureVaultModelAuth(runtime, root);
  const available = runtime.getAvailableSnapshot();
  return runtime.getProviders().filter(p => (p.id === "anthropic" || p.id === "openai-codex" || available.some(m => m.provider === p.id))).map(p => {
    const models = available.filter(m => m.provider === p.id && (p.id !== "anthropic" || runtime.isUsingSubscription(p.id)));
    return { id: `pi/${p.id}`, label: (p.id === "openai-codex" || p.id === "anthropic") ? providerLabel(p.id) : `${p.name} via Pi`, ready: models.length > 0,
      capabilities: sessionCapabilities("pi", runtime.isUsingSubscription(p.id) ? "subscription" : "api"),
      billing: runtime.isUsingSubscription(p.id) ? "subscription" as const : "api" as const,
      models: models.map(m => ({ id: m.id, label: m.name, reasoning: getSupportedThinkingLevels(m),
        capabilities: (m as typeof m & { capabilities?: Partial<ModelCapabilities> }).capabilities })),
      // An ordinary disconnection is availability, not a failed discovery.
      // Role selection supplies the shared connection guidance.
    };
  });
}
