<script lang="ts">
  import { api } from '../lib/api';
  import { app, gotoNote } from '../lib/store.svelte';
  import { sharedWorkspace } from '../lib/sharedWorkspace.svelte';
  let open = $state(false), title = $state(''), body = $state(''), error = $state(''), busy = $state(false);
  function focus(node: HTMLInputElement) { node.focus(); }
  async function submit(e: SubmitEvent) {
    e.preventDefault(); busy = true; error = '';
    try { const receipt = await api.drop(title, body); open = false; title = ''; body = ''; app.rev++; gotoNote(receipt.ref_path || receipt.path); }
    catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
{#if sharedWorkspace.writable}
  <button class="contribute" onclick={() => open = !open}>Add evidence</button>
  {#if open}
    <div class="shared-compose" role="dialog" aria-modal="true" aria-labelledby="shared-compose-title" tabindex="-1" onkeydown={e => { e.stopPropagation(); if (e.key === "Escape") open = false; }}>
      <form onsubmit={submit}>
        <h2 id="shared-compose-title">Add evidence</h2>
        <label>Title<input use:focus required bind:value={title} /></label>
        <label>Text<textarea required rows="8" bind:value={body}></textarea></label>
        {#if error}<p role="alert">{error}</p>{/if}
        <div><button disabled={busy} type="submit">{busy ? 'Adding…' : 'Add to shared vault'}</button> <button type="button" onclick={() => open = false}>Cancel</button></div>
      </form>
    </div>
  {/if}
{:else}<span class="read-only">Read only</span>{/if}
<style>
 button { color: var(--text); font: var(--type-meta); background: none; border: 1px solid var(--rule); padding: 8px 12px; cursor: pointer; }
 .contribute { white-space: nowrap; } .read-only { color: var(--text-muted); font: var(--type-meta); }
 .shared-compose { position: fixed; inset: 0; background: #0003; display: grid; place-items: center; z-index: 100; }
 form { background: var(--bg); color: var(--text); border: 1px solid var(--rule); padding: 28px; width: min(540px, calc(100vw - 80px)); display: grid; gap: 18px; font: var(--type-meta); }
 h2 { font: 500 22px var(--font-app); margin: 0; } label { display: grid; gap: 8px; }
 input, textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--rule); padding: 10px; resize: vertical; }
</style>
