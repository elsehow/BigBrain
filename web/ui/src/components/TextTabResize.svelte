<script lang="ts">
  import KeyboardModifier from "./KeyboardModifier.svelte";
  import { getContext } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  import { tooltip } from "../lib/tooltip";
  const { expanded, onresize }: { expanded: boolean; onresize: (expanded: boolean) => void } = $props();
</script>
<div class="resize-controls">
  {#if sidebar}
    <button class="width-toggle" aria-label={expanded ? "Collapse to sidebar" : "Expand to full width"} aria-keyshortcuts={expanded ? "Alt+H" : "Alt+L"} use:tooltip={expanded ? "Sidebar (Opt+h)" : "Full width (Opt+l)"} onclick={() => onresize(!expanded)}><svg viewBox="0 0 14 14" aria-hidden="true"><path d={expanded ? "m9 3-4 4 4 4" : "m5 3 4 4-4 4"} /></svg><kbd class="keyboard-hint"><KeyboardModifier name="option" />{expanded ? 'h' : 'l'}</kbd></button>
  {:else}
  <button aria-label="Standard text tab" aria-pressed={!expanded} aria-keyshortcuts={"Shift+ArrowDown"} use:tooltip={"Standard height (Shift-↓)"} onclick={() => onresize(false)}><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 5 4 4 4-4" /></svg></button>
  <button aria-label="Expand text tab" aria-pressed={expanded} aria-keyshortcuts={"Shift+ArrowUp"} use:tooltip={"Expand text tab (Shift-↑)"} onclick={() => onresize(true)}><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 9 4-4 4 4" /></svg></button>
  {/if}
</div>
<style>
  .width-toggle { width:auto; gap:5px; padding:0 4px; }
  kbd { font:10px var(--font-mono); }
  .resize-controls { display: flex; align-items: center; gap: 2px; }
  button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: none; color: inherit; background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
  button:hover { background: var(--well); } button:focus-visible { outline: 2px solid var(--activity); outline-offset: 3px; }
  svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
</style>
