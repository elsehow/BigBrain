import { providerChoice } from "../../../../lib/modelSelection";
import type { CurationAgent } from "../../../../lib/modelCatalog";
import type { ModelChoice } from "../../../../lib/modelChoice";
export type { ModelChoice } from "../../../../lib/modelChoice";
export type ModelAgent = Omit<Pick<CurationAgent, "id" | "label" | "ready" | "models" | "problem" | "capabilities">, "id"> & { id: string; billing?: "subscription" | "api" };
export function reasoningOptions(agents: ModelAgent[], choice: ModelChoice): string[] {
  const model = agents.find(a => a.id === choiceKey(choice))?.models.find(m => m.id === choice.model);
  return model?.reasoning ?? [];
}
export function changeModel(agents: ModelAgent[], choice: ModelChoice, selected: string): ModelChoice {
  const [agent, ...parts] = selected.split(":");
  const next = providerChoice(agent!, parts.join(":"));
  if (choice.reasoning && reasoningOptions(agents, next).includes(choice.reasoning)) next.reasoning = choice.reasoning;
  return next;
}

/** Composite identity is only a select-option key, never durable config. */
export function choiceKey(choice: ModelChoice): string {
  return `pi/${choice.provider}`;
}
