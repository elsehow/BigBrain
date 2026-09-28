import type { ModelProvider } from "./modelCatalog";
import { validateModelChoice, type ModelChoice, type ModelRole } from "./modelChoice";
import { selectionProblem } from "./modelResolution";
export function providerChoice(id: string, model: string): ModelChoice {
  return validateModelChoice({ adapter: 'pi', provider: id.startsWith('pi/') ? id.slice(3) : id, model });
}
export function modelsForRole(providers: readonly ModelProvider[], role: ModelRole): ModelProvider[] {
  return providers.map(provider => {
    const observation = { available: provider.ready, transport: provider.billing ?? 'subscription' as const, capabilities: provider.capabilities, problem: provider.problem };
    const choice = providerChoice(provider.id, provider.models[0]?.id ?? 'unavailable');
    const modelProblem = (model: ModelProvider['models'][number]) => selectionProblem(providerChoice(provider.id, model.id), role,
      { ...observation, available: true, modelCapabilities: model.capabilities, reasoning: model.reasoning });
    const models = provider.models.filter(model => !modelProblem(model));
    const problem = !provider.ready ? selectionProblem(choice, role, observation)
      : !models.length && provider.models.length ? modelProblem(provider.models[0]!) : provider.problem;
    return { ...provider, ready: provider.ready && !problem, ...(problem ? { problem } : {}), models };
  });
}
