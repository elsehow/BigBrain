import { modelRoleProblem, sessionCapabilities, validateModelChoice, type ModelCapabilities, type ModelChoice, type ModelRole } from './modelChoice';

export type ModelTransport = 'subscription' | 'api';
export interface ModelExecution {
  choice: ModelChoice;
  provider: string;
  transport: ModelTransport;
  capabilities: ModelCapabilities;
}
/** Discovery and live runtimes supply observations; policy is shared. Model
 * overrides describe supported features, never inferred reasoning quality. */
export interface ModelObservation {
  available: boolean;
  transport: ModelTransport;
  reasoning?: readonly string[];
  capabilities?: Partial<ModelCapabilities>;
  modelCapabilities?: Partial<ModelCapabilities>;
  problem?: string;
}
export function modelProvider(choice: ModelChoice): string {
  return choice.provider;
}
export function connectionProblem(choice: ModelChoice): string {
  if (choice.provider === "openai") return "Add an OpenAI API key in Settings > Models.";
  if (choice.adapter === "pi" && choice.provider !== "openai-codex" && choice.provider !== "anthropic") return `Connect ${choice.provider} in Pi (/login), then select an available model in Settings > Models.`;
  const name = choice.provider === 'anthropic' ? 'Claude' : choice.provider === 'openai-codex' ? 'ChatGPT' : choice.provider ?? 'OpenAI';
  return `Connect ${name}, then select an available model in Settings > Models.`;
}
export function executionFacts(choice: ModelChoice, observation: ModelObservation): ModelExecution {
  const runtime = sessionCapabilities(choice.adapter, observation.transport);
  const capabilities = Object.fromEntries(Object.entries(runtime).map(([key, supported]) => [key,
    supported && observation.capabilities?.[key as keyof ModelCapabilities] !== false && observation.modelCapabilities?.[key as keyof ModelCapabilities] !== false,
  ])) as unknown as ModelCapabilities;
  return { choice, provider: modelProvider(choice), transport: observation.transport, capabilities };
}
export function selectionProblem(choice: ModelChoice, role: ModelRole, observation: ModelObservation): string | undefined {
  if (!observation.available) return observation.problem ?? connectionProblem(choice);
  const problem = modelRoleProblem(role, executionFacts(choice, observation).capabilities);
  if (problem) return problem;
  if (choice.reasoning && observation.reasoning && !observation.reasoning.includes(choice.reasoning))
    return 'The selected model does not support that reasoning level. Select a supported level in Settings > Models.';
}
export function resolveModel(choice: ModelChoice, role: ModelRole, observation: ModelObservation): ModelExecution {
  choice = validateModelChoice(choice);
  const problem = selectionProblem(choice, role, observation);
  if (problem) throw new Error(problem);
  return executionFacts(choice, observation);
}
/** Identity and runtime labels are also valid for a failed pre-dispatch attempt. */
export function choiceJournalFields(choice: ModelChoice) {
  return { adapter: choice.adapter, provider: modelProvider(choice), model: choice.model,
    engine: 'pi' as const,
    sampling: 'pi-defaults',
    reasoning: choice.reasoning ?? '' };
}
/** Live execution adds observed billing; historical spellings remain readable. */
export function executionJournalFields(execution: ModelExecution) {
  const { choice, provider, transport } = execution;
  return { ...choiceJournalFields(choice), provider, transport,
    auth: 'pi-managed' };
}
