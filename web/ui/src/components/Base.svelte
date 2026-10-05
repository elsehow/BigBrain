<script lang="ts">
  // The base every view sits on: the vault (a shared one is checked first),
  // first run, the live stream (lib/store.svelte.ts init), and the settings
  // screens. On top of it sits one view, swappable: Field (the v2 view) or
  // Classic (the app shell with its sidebar), chosen in Settings → General.
  // Classic loads only when chosen, so its global sidebar styles never
  // reach Field.
  import { onMount } from "svelte";
  import FieldView from "./FieldView.svelte";
  import FirstRunGate from "./FirstRunGate.svelte";
  import VaultSwitcher from "./VaultSwitcher.svelte";
  import { selectedWorkspace, switchWorkspace } from "../lib/vaultScope";
  import { sharedWorkspace, checkSharedWorkspace } from "../lib/sharedWorkspace.svelte";
  import { init } from "../lib/store.svelte";
  import { startTelemetryPresence } from "../lib/telemetry";
  import { startUpdateChecks } from "../lib/update.svelte";
  import { viewChoice, type ViewKind } from "../lib/viewChoice.svelte";

  /** `view` pins the view (a workbench, a test fixture); `shell` passes through to Classic. */
  const { view, shell = {} }: { view?: ViewKind; shell?: { baseline?: boolean; debug?: boolean } } = $props();
  const kind = $derived(view ?? viewChoice.kind);

  // every view's services: whether a newer build is out (each view places
  // the banner, UpdateNudge), and the usage presence a running app reports
  $effect(() => startTelemetryPresence());
  onMount(() => {
    init();
    startUpdateChecks();
    const unavailable = () => {
      sharedWorkspace.ready = false;
      sharedWorkspace.error = "The shared vault is unavailable. Reconnecting…";
    };
    window.addEventListener("shared-unavailable", unavailable);
    void checkSharedWorkspace();
    const timer = selectedWorkspace ? setInterval(() => void checkSharedWorkspace(), 3000) : undefined;
    return () => { clearInterval(timer); window.removeEventListener("shared-unavailable", unavailable); };
  });
</script>

{#if sharedWorkspace.ready}
  <FirstRunGate>
    {#snippet children(setup)}
      {#if kind === "classic"}
        {#await import("./AppShell.svelte") then { default: AppShell }}
          <AppShell {...shell} {setup} />
        {/await}
      {:else}
        <FieldView />
      {/if}
    {/snippet}
  </FirstRunGate>
{:else}
  <div style="padding: 32px; color: var(--text); font: var(--type-meta)">
    <VaultSwitcher />
    <p role="status">{sharedWorkspace.error || "Connecting to shared vault…"}</p>
    {#if sharedWorkspace.error}<button onclick={() => void checkSharedWorkspace()}>Retry</button> <button onclick={() => switchWorkspace(null)}>Personal vault</button>{/if}
  </div>
{/if}
