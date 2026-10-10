import type { View } from "./store.svelte";

/** The settings rail and the top bar share this definition of "inside settings".
 * Each row names its rail group; the rail draws the SERVERS group, which is
 * the connected servers rather than tabs, just before SYSTEM. */
export const SETTINGS_TABS = [
  { label: "general", view: "vaultSettings", group: "GENERAL" },
  { label: "models", view: "agents", group: "GENERAL" },
  { label: "integrations", view: "integrations", group: "GENERAL" },
  { label: "lenses", view: "lenses", group: "GENERAL" },
  { label: "connected agents", view: "connectedClients", group: "AGENTS" },
  { label: "security", view: "security", group: "SYSTEM" },
  // diagnostics last (#710): the logs and the facts, read when something
  // has stopped — a screen for the bad day, below the ones for the good
  { label: "diagnostics", view: "diagnostics", group: "SYSTEM" },
] as const satisfies readonly { label: string; view: View; group: string }[];

export type SettingsTab = (typeof SETTINGS_TABS)[number]["view"] | "sharedVaultSettings";

export function isSettingsView(view: View): view is SettingsTab {
  return view === "sharedVaultSettings" || SETTINGS_TABS.some((t) => t.view === view);
}
