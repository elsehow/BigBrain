<script lang="ts">
  import { isPair, labelFor, PAIR_IDS, PAIRS, THEMES, setChoice, storedChoice, type ThemeChoice } from "../lib/theme";
  // the pairs lead, as in settings › themes: each a dot split between its halves
  const choices: ThemeChoice[] = [...PAIR_IDS, ...THEMES];
  let selected = $state<ThemeChoice>(storedChoice());
  function pick(choice: ThemeChoice): void { setChoice(choice); selected = choice; }
  $effect(() => {
    const update = () => { selected = storedChoice(); };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  });
</script>
<div class="palettes" role="group" aria-label="Theme">
  {#each choices as choice (choice)}
    <button type="button" class:selected={selected === choice} aria-label={labelFor(choice)}
      aria-pressed={selected === choice} title={labelFor(choice)} onclick={() => pick(choice)}>
      {#if isPair(choice)}
        {@const pair = PAIRS[choice]}
        <span class="dot pair"><span class="half" data-theme={pair.light}></span><span class="half" data-theme={pair.dark}></span></span>
      {:else}
        <span class="dot" data-theme={choice}></span>
      {/if}
    </button>
  {/each}
</div>
<style>
  .palettes { display: flex; gap: 6px; }
  button { display: grid; place-items: center; width: 32px; height: 32px; padding: 4px; border: 1px solid transparent; border-radius: 50%; background: none; color: var(--text); cursor: pointer; }
  button.selected { border-color: currentColor; }
  button:focus-visible { outline: 2px solid var(--accent-1); outline-offset: 2px; }
  .dot { display: block; width: 22px; height: 22px; border-radius: 50%; background: var(--bg); border: 1px solid color-mix(in srgb, var(--text) 35%, transparent); }
  .pair { display: flex; overflow: hidden; }
  .half { flex: 1; background: var(--bg); }
  @media (max-width: 420px) { .palettes { gap: 2px; } }
</style>
