<script lang="ts">
  import { vaultFetch } from '../lib/vaultScope';
  import { sharedWorkspace } from '../lib/sharedWorkspace.svelte';
  import { app } from '../lib/store.svelte';
  import type { AssertionView } from '../../../../lib/sharedVault';
  let { path }: { path: string } = $props();
  const source = $derived(path.match(/(ins_[a-f0-9]+)\.json$/)?.[1]);
  let assertions = $state<AssertionView[]>([]), text = $state(''), error = $state(''), busy = $state(false), editing = $state<string | null>(null), reason = $state('');
  $effect(() => {
    const id = source; void app.rev;
    let active = true;
    text = ''; editing = null; error = '';
    if (id) void vaultFetch('/api/shared/assertions').then(async r => { if (!r.ok) throw new Error('Could not read assertions.'); const data = await r.json(); if (active) assertions = data.filter((v: AssertionView) => !v.revocation && v.assertion.sources?.some(s => s.insertion_id === id)); }).catch(e => { if (active) error = e.message; });
    return () => { active = false; };
  });
  async function send(route: string, body: unknown) {
    busy = true; error = '';
    try { const r = await vaultFetch('/api/shared/assertions' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); text = ''; editing = null; app.rev++; }
    catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
{#if source}
  <section class="shared-assertions" aria-label="Assertions">
    {#each assertions as item}
      <article><p>{item.assertion.text.replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')}</p><small>{item.assertion.author.id}</small>
        {#if sharedWorkspace.writable && item.assertion.author.id === sharedWorkspace.handle}
          <button onclick={() => { editing = item.assertion.id; text = item.assertion.text.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '[[$1]]'); reason = ''; }}>Correct or retract</button>
        {/if}
      </article>
    {/each}
    {#if sharedWorkspace.writable}
      <form onsubmit={e => { e.preventDefault(); void send(editing ? `/${editing}/correct` : '', { text, sources: editing ? assertions.find(v => v.assertion.id === editing)?.assertion.sources?.map(s => s.insertion_id) ?? [source] : [source], ...(editing ? { reason } : {}) }); }}>
        <label>{editing ? 'Correction' : 'Make an assertion from this evidence'}<textarea bind:value={text} required rows="3"></textarea></label>
        {#if editing}<label>Reason<input bind:value={reason} required /></label>{/if}
        <div><button disabled={busy} type="submit">{editing ? 'Save correction' : 'Assert'}</button>
        {#if editing}<button type="button" disabled={busy || !reason.trim()} onclick={() => void send(`/${editing}/retract`, { reason })}>Retract</button> <button type="button" onclick={() => { editing = null; text = ''; }}>Cancel</button>{/if}</div>
      </form>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}
<style>
 .shared-assertions { margin-top: 24px; font: var(--type-meta); color: var(--text); border-top: 1px solid var(--rule); padding-top: 18px; }
 article { margin-bottom: 20px; } p { line-height: 1.5; } small { color: var(--text-muted); }
 form, label { display: grid; gap: 8px; } form { gap: 12px; }
 button { background: none; color: inherit; font: inherit; border: 1px solid var(--rule); padding: 6px 10px; cursor: pointer; }
 textarea, input { font: inherit; color: inherit; background: transparent; border: 1px solid var(--rule); padding: 8px; resize: vertical; }
</style>
