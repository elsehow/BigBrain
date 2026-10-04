import type { JobCapabilities } from "./request";
import type { ModelRole } from "../modelChoice";

/** Fixed application authority, independent of model/account preferences. */
export function jobProfile(role: string, capabilities: JobCapabilities): { role: ModelRole; tools: "gardener" | "memory" | "none" } {
  if ((role === "tend" || role === "gardener") && capabilities === "gardener") return { role: "gardener", tools: "gardener" };
  if (role === "memory" && (capabilities === "memory" || capabilities === "none")) return { role: "memory", tools: capabilities };
  if (role === "quick" && capabilities === "none") return { role: "quick", tools: "none" };
  // The goal chain (lib/goalChain.ts) reads only what it is handed; its model
  // is its own (vault.yaml chains.goals), judged like memory's.
  if (role === "goals" && capabilities === "none") return { role: "memory", tools: "none" };
  if (role === "probe" && capabilities === "none") return { role: "pilot", tools: "none" };
  throw new Error(`Unsupported job profile: ${role}/${capabilities}`);
}
