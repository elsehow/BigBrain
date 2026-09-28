import { availableDefaults, preferredDefaults, type DefaultProvider, type ProviderDefaults } from './modelDefaults';
import type { Auth } from './manifest';
import type { ModelProvider } from './modelCatalog';
import { MODEL_ROLES, type ModelChoice, type ModelRole } from './modelChoice';
import { modelsForRole, providerChoice } from './modelSelection';

/** Recommendations are opt-in subscription choices, never an API spending fallback. */
export function modelRecommendations(catalog: readonly ModelProvider[], _auth: Auth = 'max'): Partial<Record<ModelRole, ModelChoice>> {
  const result: Partial<Record<ModelRole, ModelChoice>> = {};
  for (const role of MODEL_ROLES) {
    const available: Partial<Record<DefaultProvider, ProviderDefaults>> = {};
    const destinations: Partial<Record<DefaultProvider, string>> = {};
    for (const provider of modelsForRole(catalog, role)) {
      if (!provider.ready || provider.problem || !provider.models.length || provider.billing === 'api') continue;
      if (provider.id === 'pi/anthropic' || provider.id === 'pi/openai-codex') {
        const key = provider.id === 'pi/openai-codex' ? 'openai' : 'anthropic';
        destinations[key] = provider.id;
        available[key] = availableDefaults(key, provider.models);
      }
    }
    const choice = preferredDefaults(available)[role];
    if (choice) result[role] = { ...providerChoice(destinations[choice.provider]!, choice.model),
      ...(choice.reasoning ? { reasoning: choice.reasoning } : {}) };
  }
  return result;
}
