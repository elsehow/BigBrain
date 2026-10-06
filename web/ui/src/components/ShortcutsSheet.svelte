<script lang="ts">
  // The shortcuts sheet: every key something mounted answers right now, read
  // from the registry (lib/shortcuts.svelte.ts) — so it can't list a dead one.
  import { tick, untrack } from "svelte";
  import { keyLabel, registerShortcuts, RANK, shortcutGroups } from "../lib/shortcuts.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let dialog: HTMLDialogElement;
  const groups = $derived(shortcutGroups());

  $effect(() => {
    if (open) untrack(() => { if (!dialog.open) dialog.showModal(); void tick().then(() => dialog.focus()); });
    else dialog?.close();
  });
  // while it's open the sheet is modal, so these are the only keys that answer
  $effect(() => {
    if (open) return registerShortcuts({ title: "Shortcuts", rank: RANK.modal, root: () => dialog, shortcuts: [
      { id: "shortcuts-close", label: "Close", keys: [{ key: "?" }, { key: "Escape" }], run: () => { open = false; } },
    ] });
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="sheet" aria-labelledby="shortcuts-title" tabindex="-1"
  oncancel={(e) => { e.preventDefault(); open = false; }} onclose={() => { open = false; }}
  onclick={(e) => { if (e.target === dialog) open = false; }}>
  <header><h2 id="shortcuts-title">Shortcuts</h2><button type="button" class="x" onclick={() => (open = false)} aria-label="Close shortcuts">×</button></header>
  {#each groups as g (g.title)}
    <section>
      <h3>{g.title}</h3>
      <dl>
        {#each g.items as s (s.id)}
          <div><dt>{s.label}</dt><dd>{#each s.keys as b, k (k)}{#if k}<span class="or">or</span>{/if}<kbd>{keyLabel(b)}</kbd>{/each}</dd></div>
        {/each}
      </dl>
    </section>
  {/each}
</dialog>

<style>
  .sheet { color: var(--fg); background: var(--bg); border: 1px solid color-mix(in srgb, var(--fg) 14%, var(--bg)); border-radius: 10px;
    padding: 20px 22px 22px; width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); box-sizing: border-box;
    box-shadow: 0 18px 60px -20px color-mix(in srgb, var(--fg) 45%, transparent); font: 400 13px/1.4 var(--font-app); outline: none; }
  .sheet::backdrop { background: color-mix(in srgb, var(--bg) 35%, transparent); }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  h2 { margin: 0; font: 500 15px/1.2 var(--font-app); }
  .x { border: 0; background: none; color: color-mix(in srgb, var(--fg) 55%, var(--bg)); font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
  .x:hover { color: var(--fg); }
  section + section { margin-top: 14px; }
  h3 { margin: 10px 0 6px; font: 600 10px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: color-mix(in srgb, var(--fg) 45%, var(--bg)); }
  dl { display: grid; gap: 7px; margin: 0; }
  dl div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  dt { color: color-mix(in srgb, var(--fg) 75%, var(--bg)); }
  dd { margin: 0; flex: none; display: flex; align-items: baseline; gap: 6px; }
  kbd { font: 500 11.5px/1 var(--font-mono); color: var(--fg); padding: 3px 6px; border-radius: 4px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .or { font-size: 11px; color: color-mix(in srgb, var(--fg) 45%, var(--bg)); }
</style>
