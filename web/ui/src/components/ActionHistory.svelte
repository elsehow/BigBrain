<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { refreshSourceAttention, sourceAttention } from '../lib/sourceAttention.svelte';
  import { actionHistory } from '../lib/actionHistory.svelte';
  import { actionLabel, actionOutcome, actionNextStep, type PublicAction } from '../lib/actionHistoryView';
  import { vaultFetch } from '../lib/vaultScope';
  import { gotoNote } from '../lib/store.svelte';
  import { selectWork } from '../lib/workSessions.svelte';
  let dialog: HTMLDialogElement;
  let records = $state<PublicAction[]>([]), busy = $state(false), error = $state(''), incomplete = $state(false), cursor = $state<string>();
  let alive = true;
  let providerChecked = $state(false);
  async function refreshProvider() { await refreshSourceAttention(true); providerChecked = true; }
  async function load(more = false) {
    if (busy) return;
    busy = true; error = '';
    try {
      const query = new URLSearchParams({ limit: '30' });
      if (actionHistory.pilot) query.set('id', actionHistory.pilot);
      if (more && cursor) query.set('cursor', cursor);
      const response = await vaultFetch(`${actionHistory.pilot ? '/api/pilot/chat/actions' : '/api/actions'}?${query}`);
      if (!response.ok) throw new Error('Action history is unavailable. Refresh to inspect it again.');
      const body = await response.json();
      if (!Array.isArray(body.receipts)) throw new Error('Action history is unavailable.');
      if (!alive) return;
      records = more ? [...records, ...body.receipts] : body.receipts;
      incomplete = body.complete === false; cursor = body.nextCursor;
    } catch (e) { if (alive) error = (e as Error).message; }
    finally { if (alive) busy = false; }
  }
  function close() { if (alive) actionHistory.open = false; }
  function inspect(target: string, kind: string) {
    close(); if (kind === 'agent') selectWork(target); else gotoNote(target);
  }
  onMount(() => {
    const opener = document.activeElement;
    dialog.showModal(); void load();
    return () => { alive = false; dialog.close(); void tick().then(() => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); }); };
  });
</script>

<dialog bind:this={dialog} class="action-history" aria-labelledby="action-history-title" onclose={close} oncancel={close}>
  <header><h2 id="action-history-title">{actionHistory.title}</h2><button onclick={close} aria-label="Close action history">Close</button></header>
  <p>Saved observations of attempted actions. Opening or refreshing this view never repeats an action.</p>
  <button onclick={() => void load()} disabled={busy}>Refresh history</button>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if incomplete}<p role="alert">Some action records are unreadable. Their saved bytes have been preserved. Missing history does not mean an action did not happen.</p>{/if}
  {#if busy}<p role="status">Loading action history…</p>{/if}
  {#if !busy && !error && records.length === 0}<p>No readable actions were found.</p>{/if}
  {#if records.some(record => record.operation.startsWith('source_set_unread'))}
    <button onclick={() => void refreshProvider()} disabled={sourceAttention.loading}>Refresh current source states</button>
    {#if providerChecked}<p role="status">{sourceAttention.refreshError || 'Current source states refreshed. Inspect a source to see its current state; saved action observations remain unchanged.'}</p>{/if}
  {/if}
  <ol>
    {#each records as record (record.id)}
      {@const outcome = actionOutcome(record)}
      <li>
        <h3>{actionLabel(record.operation)} <span>{outcome.label}</span></h3>
        {#if record.created}<time datetime={record.created}>{new Date(record.created).toLocaleString()}</time>{/if}
        <p>{outcome.explanation}</p>
        {#each record.observations ?? [] as observation, i}
          <div class="observation">
            <span>{observation.kind === 'read-state' ? `Item ${i + 1}: ${observation.confirmed ? observation.unread ? 'unread confirmed' : 'read confirmed' : 'not confirmed'}` : observation.kind === 'agent' ? 'Agent recorded' : 'Contribution saved'}</span>
            {#if observation.target}<button onclick={() => inspect(observation.target!, observation.kind)}>Inspect {observation.kind === 'agent' ? 'agent' : 'source'}</button>{/if}
          </div>
        {/each}
        <p class="next-step">{actionNextStep(record.operation)}</p>
      </li>
    {/each}
  </ol>
  {#if cursor}<button onclick={() => void load(true)} disabled={busy}>Older actions</button>{/if}
</dialog>

<style>
  dialog { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); box-sizing:border-box; overflow:auto; padding:24px; background:var(--bg); color:var(--ink); border:1px solid var(--rule); border-radius:12px; }
  button { font:var(--type-meta); color:var(--ink); background:var(--bg); border:1px solid var(--rule); border-radius:6px; padding:7px 10px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; } button:focus-visible { outline:2px solid var(--activity); outline-offset:2px; }
  dialog::backdrop { background:rgb(0 0 0 / .3); }
  header { display:flex; align-items:center; gap:16px; } h2 { flex:1; margin:0; font:var(--type-heading); } h3 { font:var(--type-body); margin:0; display:flex; flex-wrap:wrap; gap:8px; }
  h3 span, time, .next-step { color:var(--muted); font:var(--type-meta); }
  p { line-height:1.5; } ol { list-style:none; padding:0; } li { border-top:1px solid var(--rule); padding:16px 0; overflow-wrap:anywhere; }
  .observation { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:8px 0; }
</style>
