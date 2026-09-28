<script lang="ts">
  import AgentConnection from "./AgentConnection.svelte";
  import { claudeProviderConnected, type SetupState } from "../lib/setup";
  let { setup, onConnect, onUpdatePlugin, compact = false, name = "Claude" }: {
    setup: SetupState; compact?: boolean; name?: string;
    onConnect?: () => Promise<void> | void;
    onUpdatePlugin?: () => Promise<void> | void;
  } = $props();
</script>

<AgentConnection {name} version={setup.claude.installed}
  signedIn={setup.claude.account !== null} account={setup.claude.account ?? ""}
  connected={claudeProviderConnected(setup)}
  {compact} {onConnect}
  installCommand="curl -fsSL https://claude.ai/install.sh | bash">
  {#snippet signin()}<p>Run <code>claude</code> to sign in.</p>{/snippet}
</AgentConnection>

<style>
  p { margin: 0; font: var(--type-meta); color: var(--text-muted); }
  code { font: var(--type-mono); }
</style>
