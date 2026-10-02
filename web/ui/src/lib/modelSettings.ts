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

const DATED = /-(\d{8}|\d{4}-\d{2}-\d{2})$/, VERSION = /\d+(?:[.-]\d+)*/;
const family = (id: string) => id.replace(DATED, "").replace(VERSION, "#");
const version = (id: string) => id.replace(DATED, "").match(VERSION)?.[0].split(/[.-]/).map(Number) ?? [];
function newer(a: string, b: string): boolean {
  const x = version(a), y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return a.length < b.length; // same version: the undated alias beats its dated snapshot
}
/** Menus offer only the newest model of each family (`claude-opus-#`, `gpt-#-mini`),
 * preferring an undated alias over its dated snapshot. A saved older choice stays listed. */
export function latestModels<M extends { id: string; label: string }>(models: readonly M[], saved?: string): M[] {
  const best = new Map<string, M>();
  for (const model of models) {
    const key = family(model.id), current = best.get(key);
    if (!current || newer(model.id, current.id)) best.set(key, model);
  }
  const shown = new Set(best.values());
  return models.filter(m => shown.has(m) || m.id === saved).map(m => ({ ...m, label: m.label.replace(/ \(latest\)$/, "") }));
}

/** Composite identity is only a select-option key, never durable config. */
export function choiceKey(choice: ModelChoice): string {
  return `pi/${choice.provider}`;
}
