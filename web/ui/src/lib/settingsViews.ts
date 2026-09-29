import type { View } from "./store.svelte";

/** The settings rail and the top bar share this definition of "inside settings".
 * Vault comes first, including Pilot and Shortcuts; diagnostics comes last. */
export const SETTINGS_TABS = [
  { label: "general", view: "vaultSettings" },
  { label: "models", view: "agents" },
  { label: "integrations", view: "integrations" },
  { label: "connected clients", view: "connectedClients" },
  { label: "connected agents", view: "agentOrchestration" },
  // diagnostics last (#710): the logs and the facts, read when something
  // has stopped — a screen for the bad day, below the ones for the good
  { label: "diagnostics", view: "diagnostics" },
] as const satisfies readonly { label: string; view: View }[];

export type SettingsTab = (typeof SETTINGS_TABS)[number]["view"] | "sharedVaultSettings";

export function isSettingsView(view: View): view is SettingsTab {
  return view === "sharedVaultSettings" || view === "pilotSettings" || SETTINGS_TABS.some((t) => t.view === view);
}
