import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { modelDescriptor } from "./modelRegistry";

import { MODEL_ROLES, type ModelRole } from "./modelChoice";
export { MODEL_ROLES, type ModelRole } from "./modelChoice";
export type DefaultProvider = "anthropic" | "openai";
export type RoleDefault = { model: string; reasoning?: string };
export type ProviderDefaults = Record<ModelRole, RoleDefault>;
const catalog = parse(readFileSync(new URL("./model-defaults.yaml", import.meta.url), "utf8")) as
  Record<DefaultProvider, ProviderDefaults> & { preferences?: Partial<Record<ModelRole, DefaultProvider[]>> };
export const MODEL_DEFAULTS: Record<DefaultProvider, ProviderDefaults> = { anthropic: catalog.anthropic, openai: catalog.openai };
export const PROVIDER_PREFERENCES = catalog.preferences ?? {};
for (const [role, providers] of Object.entries(PROVIDER_PREFERENCES)) {
  if (!MODEL_ROLES.includes(role as ModelRole) || !Array.isArray(providers) || !providers.length ||
      new Set(providers).size !== providers.length || providers.some(p => p !== "anthropic" && p !== "openai"))
    throw new Error(`Invalid ${role} provider preference in model-defaults.yaml`);
}
for (const provider of ["anthropic", "openai"] as const) {
  for (const role of MODEL_ROLES) {
    const choice = MODEL_DEFAULTS[provider]?.[role];
    if (!choice || modelDescriptor(choice.model)?.provider !== provider)
      throw new Error(`Invalid ${provider} ${role} default in model-defaults.yaml`);
  }
}

/** Resolve recommendations only when configuring preferences, never at dispatch.
 * A catalog without the recommendation uses its declared default/first model. */
export function availableDefaults(provider: DefaultProvider, models: readonly { id: string; isDefault?: boolean; reasoning?: string[] }[]): ProviderDefaults {
  const fallback = models.find(m => m.isDefault) ?? models[0];
  if (!fallback) throw new Error(`No ${provider === "openai" ? "ChatGPT" : "Claude"} model is available.`);
  return Object.fromEntries(MODEL_ROLES.map(role => {
    const desired = MODEL_DEFAULTS[provider][role];
    // Claude Code accepts family aliases; Pi requires the native model ID.
    const family = provider === "anthropic" ? models.filter(m => new RegExp(`^claude-${desired.model}-\\d`).test(m.id))
      .sort((a, b) => b.id.replace(/-\d{8}$/, "").localeCompare(a.id.replace(/-\d{8}$/, ""), undefined, { numeric: true }) || a.id.length - b.id.length) : [];
    const model = models.find(m => m.id === desired.model) ?? family[0] ?? fallback;
    return [role, { model: model.id, ...(desired.reasoning && model.reasoning?.includes(desired.reasoning) ? { reasoning: desired.reasoning } : {}) }];
  })) as ProviderDefaults;
}


/** Rank connected providers at configuration time and on connection changes. */
export function preferredDefaults(available: Partial<Record<DefaultProvider, ProviderDefaults>>):
  Partial<Record<ModelRole, RoleDefault & { provider: DefaultProvider }>> {
  const choices: Partial<Record<ModelRole, RoleDefault & { provider: DefaultProvider }>> = {};
  for (const role of MODEL_ROLES) {
    const provider = PROVIDER_PREFERENCES[role]?.find(provider => available[provider]);
    if (provider) choices[role] = { provider, ...available[provider]![role] };
  }
  return choices;
}
