<!-- The strips above the top bar, one slot in every view: a newer build
     (UpdateNudge) and a provider out of usage credits (CreditsBanner).
     In the sidebar layout the slot is pinned over the sidebar, and its
     height is what the sidebar's chrome moves down by. -->
<script lang="ts">
  import { getContext } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  import CreditsBanner from "./CreditsBanner.svelte";
  import UpdateNudge from "./UpdateNudge.svelte";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  let height = $state(0);
  $effect(() => {
    if (!sidebar) return;
    document.documentElement.style.setProperty("--sidebar-update-height", `${height}px`);
    return () => document.documentElement.style.removeProperty("--sidebar-update-height");
  });
</script>

<div class="strips" class:sidebar={!!sidebar} bind:offsetHeight={height}>
  <UpdateNudge />
  <CreditsBanner />
</div>

<style>
  /* Above both the canvas and the top bar (z-index 4), including while
     the bar slides upward through the strips' bounds. */
  .strips { position: relative; z-index: 5; flex: 0 0 auto; display: flex; flex-direction: column; }
  .sidebar { position: fixed; top: 0; left: 0; width: var(--sidebar-width); z-index: 130; }
</style>
