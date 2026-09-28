<!-- The update banner: one strip above the top bar, only ever present when
     the shell reported a newer build on the site (lib/update.svelte.ts).
     One click downloads, verifies and relaunches; × keeps THIS version
     quiet for good. Nothing here downloads on its own. -->
<script lang="ts">
  import { getContext } from "svelte";
  import { fly } from "svelte/transition";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  let height = $state(0);
  $effect(() => {
    if (!sidebar) return;
    document.documentElement.style.setProperty("--sidebar-update-height", update.available ? `${height}px` : "0px");
    return () => document.documentElement.style.removeProperty("--sidebar-update-height");
  });
  import { dismiss, install, update } from "../lib/update.svelte";
  import { tooltip } from "../lib/tooltip";
</script>

{#if update.available}
  <div class="nudge" class:sidebar-nudge={!!sidebar} bind:offsetHeight={height} role="status" transition:fly={{ y: -12, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 }}>
    {#if update.phase === "installing"}
      <span>Updating to {update.available.version} — BigBrain will relaunch itself…</span>
    {:else}
      <span>{sidebar ? `Update ${update.available.version}` : `BigBrain ${update.available.version} is ready.`}</span>
      {#if update.phase === "failed"}
        <span class="err">The update didn't take — {update.error}</span>
      {/if}
      <button class="go" onclick={() => void install()}>{update.phase === "failed" ? "Try again" : "Update & relaunch"}</button>
      <button class="x" onclick={dismiss} aria-label="Not now" use:tooltip={"Not now"}>×</button>
    {/if}
  </div>
{/if}

<style>
  /* Above both the canvas and the top bar (z-index 4), including while
     the bar slides upward through the banner's bounds. */
  .nudge { position: relative; z-index: 5;
    flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-4);
    padding: 9px var(--app-gutter); font: var(--type-meta); color: var(--text);
    background: color-mix(in srgb, var(--accent-1) 11%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, var(--accent-1) 24%, transparent); }
  .err { color: var(--err); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .go { flex: none; margin-left: auto; font: var(--type-chip); color: var(--text-strong);
    background: color-mix(in srgb, var(--accent-1) 22%, var(--bg));
    border: none; border-radius: var(--r-chip); padding: 5px 12px; cursor: pointer; }
  .go:hover { background: color-mix(in srgb, var(--accent-1) 32%, var(--bg)); }
  .x { flex: none; font: var(--type-meta); line-height: 1; color: var(--text-faint);
    background: none; border: none; padding: 2px 4px; cursor: pointer; }
  .sidebar-nudge { position:fixed; top:0; left:0; width:var(--sidebar-width); box-sizing:border-box; z-index:130; min-height:48px; padding:10px 24px; gap:12px; flex-wrap:wrap; background:var(--text-strong); color:var(--bg); border-bottom:1px solid var(--text-strong); border-right:1px solid var(--text-strong); font:var(--type-meta); }
  .sidebar-nudge .go { font:inherit; color:inherit; background:transparent; padding:5px 0; border-radius:0; }
  .sidebar-nudge .go:hover { text-decoration:underline; }
  .sidebar-nudge .x { color:inherit; font-size:18px; padding:4px; }
  .sidebar-nudge .err { color:inherit; order:3; flex-basis:100%; white-space:normal; overflow-wrap:anywhere; }
  .x:hover { color: var(--text); }
  .sidebar-nudge .x:hover { color:inherit; opacity:.7; }
</style>
