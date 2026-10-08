<!-- The update banner: one strip above the top bar (TopStrips places it), only ever present when
     the shell reported a newer build on the site (lib/update.svelte.ts).
     One click downloads, verifies and relaunches; × keeps THIS version
     quiet for good. Nothing here downloads on its own. -->
<script lang="ts">
  import { fly } from "svelte/transition";
  import { dismiss, install, update } from "../lib/update.svelte";
  import { tooltip } from "../lib/tooltip";
</script>

{#if update.available}
  <div class="nudge" role="status" transition:fly={{ y: -12, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 }}>
    {#if update.phase === "installing"}
      <span>Updating to {update.available.version} — BigBrain will relaunch itself…</span>
    {:else}
      <span>BigBrain {update.available.version} is ready.</span>
      {#if update.phase === "failed"}
        <span class="err">The update didn't take — {update.error}</span>
      {/if}
      <button class="go" onclick={() => void install()}>{update.phase === "failed" ? "Try again" : "Update & relaunch"}</button>
      <button class="x" onclick={dismiss} aria-label="Not now" use:tooltip={"Not now"}>×</button>
    {/if}
  </div>
{/if}

<style>
  .nudge { display: flex; align-items: center; gap: var(--sp-4);
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
  .x:hover { color: var(--text); }
</style>
