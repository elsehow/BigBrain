<script lang="ts">
  import { THEMES, THEME_LABEL, setChoice, storedChoice, themeFor, systemPrefersDark, type Theme } from "../lib/theme";
  let selected = $state<Theme>(themeFor(systemPrefersDark(), storedChoice()) ?? "default");
  function pick(theme: Theme): void { setChoice(theme); selected = theme; }
  $effect(() => {
    const update = () => { selected = themeFor(systemPrefersDark(), storedChoice()) ?? "default"; };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  });
</script>
<div class="palettes" role="group" aria-label="Theme">
  {#each THEMES as theme}
    <button type="button" class:selected={selected === theme} aria-label={THEME_LABEL[theme]}
      aria-pressed={selected === theme} title={THEME_LABEL[theme]} onclick={() => pick(theme)}>
      <span data-theme={theme}></span>
    </button>
  {/each}
</div>
<style>
  .palettes { display: flex; gap: 6px; }
  button { display: grid; place-items: center; width: 32px; height: 32px; padding: 4px; border: 1px solid transparent; border-radius: 50%; background: none; color: var(--text); cursor: pointer; }
  button.selected { border-color: currentColor; }
  button:focus-visible { outline: 2px solid var(--accent-1); outline-offset: 2px; }
  span { display: block; width: 22px; height: 22px; border-radius: 50%; background: var(--bg); border: 1px solid color-mix(in srgb, var(--text) 35%, transparent); }
  @media (max-width: 420px) { .palettes { gap: 2px; } }
</style>
