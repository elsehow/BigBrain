import type { PilotViewData } from "./pilotChatSync";

export const GENERAL_WORKSPACE = 'workspace:general';

/** Graph assignments are computed in the background, never during menu
 * navigation. Missing/deleted memories remain discoverable in General. */
export function workspaceMembershipIndex(memories: readonly { id: string; path?: string | null }[]) {
  const ids = new Map<string, string>();
  for (const memory of memories) {
    if (/(^|\/)MEMORY\.md$/.test(memory.path ?? memory.id)) continue;
    ids.set(memory.id, memory.id);
    if (memory.path) ids.set(memory.path, memory.id);
  }
  return {
    forAgents(agents: readonly Pick<PilotViewData, 'id' | 'category'>[]) {
      return new Map(agents.map(agent => [agent.id,
        new Set([agent.category?.memory && ids.get(agent.category.memory) || GENERAL_WORKSPACE])]));
    },
  };
}
