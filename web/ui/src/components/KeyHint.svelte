<script lang="ts">
  import { keyboardHints } from "../lib/keyboardHints.svelte";
  // The mockup's screen-footer shortcut line (COMPONENTS.md § KeyHint):
  // mono segments split on "·", spaced wide. Callers list ONLY keys their
  // screen actually handles today — a hint for a dead key is a lie.
  // `flush` drops the top padding, which exists for the screen-foot
  // placement; a caller putting the line mid-page spaces it itself.
  const { hints, flush = false }: { hints: string; flush?: boolean } = $props();
  const segments = $derived(hints.split("·").map((s) => s.trim()).filter(Boolean));
</script>

{#if keyboardHints.show}<div class="keyhint" class:flush aria-hidden="true">
  {#each segments as s, i (i)}
    <span>{s}</span>
  {/each}
</div>{/if}

<style>
  .keyhint { display: flex; flex-wrap: wrap; gap: var(--sp-7); padding-top: var(--sp-9);
    font: var(--type-mono); letter-spacing: 0.08em; color: var(--text-muted); }
  .keyhint.flush { padding-top: 0; }
</style>
