import type { ModelSessionSetup } from "./run/session";
import { monitoredSession } from "./run/monitor";
import { createModelSession } from "./run/sessionFactory";
import { PilotError } from "./pilot";
import type { PilotConversation } from "./pilotConversation";
import { validateModelChoice } from "./modelChoice";
import type { PilotBackend, PilotBackendConfig } from "./pilotBackendTypes";

export interface PilotBackendSetup extends ModelSessionSetup {
  config: PilotBackendConfig;
  state: PilotConversation;
}
export type PilotBackendFactory = (setup: PilotBackendSetup) => PilotBackend;
export const createPilotBackend: PilotBackendFactory = setup => monitoredSession(createModelSession(setup), setup, "pilot");
export function validatePilotBackend(value: unknown): PilotBackendConfig {
  try { return validateModelChoice(value); }
  catch (error) { throw new PilotError(error instanceof Error ? error.message : String(error)); }
}
