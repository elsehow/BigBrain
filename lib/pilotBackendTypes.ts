/** Provider-independent session configuration. Adapter IDs select installed transports. */
export type { ModelChoice as PilotBackendConfig } from "./modelChoice";
import { readModelChoice, type ModelChoice as PilotBackendConfig } from "./modelChoice";
export const DEFAULT_PILOT_BACKEND: PilotBackendConfig = { adapter: "pi", provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "low" };
export type { ModelSessionTurn as PilotBackendTurn, ModelSession as PilotBackend } from "./run/session";

/** Decode saved settings only. New requests cannot select the retired adapter. */
export function migratePilotBackend(config: Parameters<typeof readModelChoice>[0]): PilotBackendConfig {
  if (config.adapter === "pi") return readModelChoice({ ...config, provider: config.provider ?? "openai-codex" });
  return readModelChoice(config);
}
