<script lang="ts">
  // The base every view sits on: the vault (a shared one is checked first),
  // first run, the live stream (lib/store.svelte.ts init), and the settings
  // screens. On top of it sits Field (the v2 view).
  import { onMount } from "svelte";
  import FieldView from "./FieldView.svelte";
  import FirstRunGate from "./FirstRunGate.svelte";
  import { selectedWorkspace, leaveWorkspace } from "../lib/vaultScope";
  import { sharedWorkspace, checkSharedWorkspace } from "../lib/sharedWorkspace.svelte";
  import { init } from "../lib/store.svelte";
  import { startTelemetryPresence } from "../lib/telemetry";
  import { startUpdateChecks } from "../lib/update.svelte";
  import { openExternalLinks } from "../lib/links";

  // every view's services: whether a newer build is out (each view places
  // the banner in its TopStrips), and the usage presence a running app reports
  $effect(() => startTelemetryPresence());
  onMount(() => {
    init();
    startUpdateChecks();
    const unavailable = () => {
      sharedWorkspace.ready = false;
      sharedWorkspace.error = "The server is unavailable. Reconnecting…";
    };
    window.addEventListener("shared-unavailable", unavailable);
    void checkSharedWorkspace();
    const timer = selectedWorkspace ? setInterval(() => void checkSharedWorkspace(), 3000) : undefined;
    return () => { clearInterval(timer); window.removeEventListener("shared-unavailable", unavailable); };
  });
</script>

<!-- a link that leaves the document opens OUTSIDE the app (lib/links.ts):
     the shell's webview has no way back from a page -->
<svelte:window onclick={openExternalLinks} />

{#if sharedWorkspace.ready}
  <FirstRunGate>
    <FieldView />
  </FirstRunGate>
{:else}
  <div style="padding: 32px; color: var(--text); font: var(--type-meta)">
    <p role="status">{sharedWorkspace.error || "Connecting to server…"}</p>
    {#if sharedWorkspace.error}<button onclick={() => void checkSharedWorkspace()}>Retry</button> <button onclick={leaveWorkspace}>Your vault</button>{/if}
  </div>
{/if}
