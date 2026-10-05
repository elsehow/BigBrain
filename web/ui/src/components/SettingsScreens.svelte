<script lang="ts">
  // The settings screens, by the hash (#/integrations, #/agents, …): the one
  // set every view shows, whatever it shows them in. Classic puts them under
  // its top bar; Field in a panel over the field (FieldView.svelte).
  import AgentsView from "./AgentsView.svelte";
  import ConnectedClientsView from "./ConnectedClientsView.svelte";
  import DiagnosticsView from "./DiagnosticsView.svelte";
  import IntegrationsView from "./IntegrationsView.svelte";
  import PilotSettingsView from "./PilotSettingsView.svelte";
  import SharedVaultSettings from "./SharedVaultSettings.svelte";
  import VaultSettingsView from "./VaultSettingsView.svelte";
  import { app } from "../lib/store.svelte";
</script>

{#if app.view === "integrations"}
  <IntegrationsView />
{:else if app.view === "connectedClients"}
  <ConnectedClientsView />
{:else if app.view === "pilotSettings"}
  <PilotSettingsView />
{:else if app.view === "agents"}
  <AgentsView />
{:else if app.view === "sharedVaultSettings"}
  <SharedVaultSettings />
{:else if app.view === "vaultSettings" || app.view === "themes"}
  <VaultSettingsView />
{:else if app.view === "diagnostics"}
  <DiagnosticsView />
{/if}
