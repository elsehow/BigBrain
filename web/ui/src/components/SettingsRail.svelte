<script lang="ts">
  // The settings rail. What settings ARE, split by direction of travel:
  // agents act ON the vault (outbound credentials, with a revoke),
  // integrations feed INTO it (inbound pollers, with an enable toggle).
  // Both are things you configure once and leave alone.
  //
  // A log-out row ended the list until 2026-08-30, when the edge contract
  // it belonged to went (#570): one vault, one machine, one operator —
  // there is no session to leave.
  //
  // WORK QUEUE was a section of its own above SETTINGS until 2026-08-28,
  // when the screen it opened was deleted: it read the queue home already
  // reads for the ingest ETA and laid it out as a table nobody used. The
  // editor's own configuration is the agents card — see AgentsView for the
  // boundary, and the plan's decision 5 for why.
  //
  // The rows themselves live in lib/settingsViews.ts — the ONE list of what
  // "inside settings" means, which the top bar reads too (since 2026-09-02;
  // its own copy had missed the shortcuts row).
  import { SETTINGS_TABS, type SettingsTab } from "../lib/settingsViews";
  import { goto } from "../lib/store.svelte";

  const { active, extraSection }: { active: SettingsTab; extraSection?: { label: string; active: boolean; items: { label: string; selected: boolean; onselect: () => void }[] } } = $props();
</script>

<div class="rail">
  <span class="rail-eyebrow first">SETTINGS</span>
  <span class="rail-eyebrow">GENERAL</span>
  {#each SETTINGS_TABS as s (s.view)}
    {#if s.view === "connectedClients"}<span class="rail-eyebrow">AGENTS</span>{:else if s.view === "diagnostics"}<span class="rail-eyebrow">SYSTEM</span>{/if}
    <button class="rail-row" class:on={!extraSection?.active && active === s.view} onclick={() => goto(s.view)}>{s.label}</button>
    {#if s.view === "integrations" && extraSection}
      <span class="rail-eyebrow">{extraSection.label}</span>
      {#each extraSection.items as item}
        <button class="rail-row" class:on={item.selected} aria-current={item.selected ? 'page' : undefined} onclick={item.onselect}>{item.label}</button>
      {/each}
    {/if}
  {/each}
</div>

<style>
  .rail { width: 148px; flex: none; display: flex; flex-direction: column;
    gap: var(--sp-4); padding-top: var(--sp-1); }
  .rail-eyebrow { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow);
    color: var(--text-faint); margin-top: var(--sp-5); }
  /* …except at the top of the rail, where it sets the content column's first
     line */
  .rail-eyebrow.first { margin-top: 0; }
  .rail-row { border: none; background: none; padding: 0; text-align: left; cursor: pointer;
    font: var(--type-body); color: var(--text-faint); }
  .rail-row:hover { color: var(--text); }
  .rail-row.on { color: var(--text-strong); }
</style>
