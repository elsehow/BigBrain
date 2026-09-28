import { loadManifest } from "./manifest";
import { applyConfig } from "./config";
import { readEnvValues, writeEnvValues } from "./envFile";
import type { ModelProvider } from "./modelCatalog";
import { MODEL_ROLES, modelPreference, type ModelPreference, type ModelRole } from "./modelChoice";
import { modelRecommendations } from "./modelRecommendations";

export function modelPreferences(root: string): Record<ModelRole, ModelPreference> {
  const env = readEnvValues(root);
  return { ...loadManifest(root).modelPreferences,
    pilot: modelPreference(env.BIGBRAIN_PILOT_MODEL_PREFERENCE, env.BIGBRAIN_PILOT_BACKEND ? "pinned" : "recommended") };
}
/** Discovery is read-only. Lifecycle refreshes change only opted-in roles. */
export function refreshModelPreferences(root: string, catalog: readonly ModelProvider[]): void {
  if (catalog.some(provider => provider.problem)) return;
  const preferences = modelPreferences(root), choices = modelRecommendations(catalog, loadManifest(root).auth);
  const patch = Object.fromEntries(MODEL_ROLES.filter(role => role !== "pilot" && preferences[role] === "recommended" && choices[role])
    .map(role => [role, { ...choices[role]!, reasoning: choices[role]!.reasoning ?? null, preference: "recommended" }]));
  if (Object.keys(patch).length) applyConfig(patch, root);
  if (preferences.pilot === "recommended" && choices.pilot) writeEnvValues(root, {
    BIGBRAIN_PILOT_BACKEND: JSON.stringify(choices.pilot), BIGBRAIN_PILOT_MODEL_PREFERENCE: "recommended",
  });
}
export function setModelPreference(root: string, role: ModelRole, value: unknown, catalog: readonly ModelProvider[]): void {
  if (!MODEL_ROLES.includes(role)) throw new Error("Unknown model role.");
  const preference = modelPreference(value, "pinned");
  const choice = preference === "recommended" ? modelRecommendations(catalog, loadManifest(root).auth)[role] : undefined;
  if (preference === "recommended" && !choice) throw new Error("Connect an eligible subscription provider before following recommendations.");
  if (role === "pilot") {
    writeEnvValues(root, { BIGBRAIN_PILOT_MODEL_PREFERENCE: preference,
      ...(choice ? { BIGBRAIN_PILOT_BACKEND: JSON.stringify(choice) } : {}) });
  } else {
    const saved = loadManifest(root)[role];
    applyConfig({ [role]: { ...(choice ?? saved), reasoning: (choice ?? saved).reasoning ?? null, preference } }, root);
  }
}
