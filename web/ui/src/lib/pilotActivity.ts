import type { PilotViewData } from "./pilotChatSync";

/** Only explicit user archiving ends UI activity; background ingestion and age do not. */
export function isActivePilot(s: Pick<PilotViewData, "deactivatedAt">): boolean {
  return !s.deactivatedAt;
}
