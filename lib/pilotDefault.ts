/** The Pilot model chosen in Settings › Models (`BIGBRAIN_PILOT_BACKEND`), or
 * the engine default when none is saved. Pilot chats and Desktops both start
 * on it; reading the constant instead is how new Desktops ignored the setting. */
import { readEnvValues } from "./envFile";
import { validateModelChoice } from "./modelChoice";
import { DEFAULT_PILOT_BACKEND, migratePilotBackend, type PilotBackendConfig } from "./pilotBackendTypes";

export function savedPilotBackend(root: string): PilotBackendConfig {
  const saved = readEnvValues(root).BIGBRAIN_PILOT_BACKEND;
  return saved ? validateModelChoice(migratePilotBackend(JSON.parse(saved))) : { ...DEFAULT_PILOT_BACKEND };
}
