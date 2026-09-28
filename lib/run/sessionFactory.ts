import { validateModelChoice } from "../modelChoice";
import { PiSession, type PiSDK } from "./piSession";
import type { ModelSessionSetup, ModelSession } from "./session";

/** One runtime for all roles; host capabilities and monitoring belong to callers. */
export function createModelSession(setup: ModelSessionSetup, loaders: { pi?: () => Promise<PiSDK> } = {}): ModelSession {
  return new PiSession({ ...setup, config: validateModelChoice(setup.config) }, loaders.pi, setup.requireText ?? true);
}
