<script lang="ts">
  import AppShell from "../../components/AppShell.svelte";
  import ThemeView from "../../components/ThemeView.svelte";
  import { goto } from "../../lib/store.svelte";
  let details = $state(false);
</script>

<AppShell />
<div class="preview-mark">
  <button aria-expanded={details} onclick={() => details = !details}>Simulated preview <span aria-hidden="true">{details ? "−" : "+"}</span></button>
</div>
{#if details}
  <aside class="preview-details" aria-label="Preview controls and provenance">
    <div class="heading"><strong>Integration preview</strong><button onclick={() => details = false} aria-label="Close preview controls">×</button></div>
    <p>Fabricated data only. Changes stay in this page; no OAuth, model, provider or vault calls.</p>
    <button onclick={() => { goto("integrations"); details = false; }}>Back to Integrations</button>
    <ThemeView />
    <p>Production AppShell and Settings; prototype Integrations content. Offline system fonts.</p>
    <p>{import.meta.env.VITE_INTEGRATION_PREVIEW_SOURCE}</p>
  </aside>
{/if}

<style>
  .preview-mark { position: fixed; right: 12px; bottom: 10px; z-index: 500; }
  .preview-mark button, .preview-details button { font: var(--type-meta); background: var(--bg); color: var(--text-muted); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 7px 10px; cursor: pointer; }
  .preview-mark span { margin-left: 8px; }
  .preview-details { position: fixed; z-index: 501; right: 12px; bottom: 50px; width: min(520px, calc(100vw - 24px)); max-height: calc(100dvh - 100px); overflow: auto; background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-card); box-shadow: var(--shadow-card); padding: 22px; color: var(--fg); }
  .preview-details p { font: var(--type-meta); color: var(--text-muted); margin: 16px 0; }
  .heading { display: flex; justify-content: space-between; align-items: center; }
  .preview-details :global(.themes) { margin-top: 22px; }
</style>
