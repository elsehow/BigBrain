<script lang="ts">
  import '../design/notification.css';
  // Pointer-only: the keyboard layer (n to focus, j/k, i/o/c) ran through a
  // dispatcher Classic owned, and went dead with it (#100, #129).
  import { notificationStack } from '../lib/notificationStack.svelte';
  let panel: HTMLElement | undefined = $state();
  let errors = $state<Record<string, string>>({});
  let clearing = $state<string[]>([]);
  const items = $derived(notificationStack.items);
  function enterInput(id: string) {
    panel?.querySelector(`[data-notice-id="${CSS.escape(id)}"]`)?.querySelector<HTMLInputElement>('input:not(:disabled), textarea:not(:disabled)')?.focus();
  }
  async function settle(id: string, run?: () => void | Promise<void>) {
    if (clearing.includes(id)) return;
    clearing = [...clearing, id];
    try { await run?.(); delete errors[id]; }
    catch (error) { errors[id] = (error as Error).message; }
    finally { clearing = clearing.filter(value => value !== id); }
  }
  const clear = (id: string) => settle(id, items.find(item => item.id === id)?.onclear);
  const KIND = { capture: 'Capture', agent: 'Agent', connection: 'Connection' } as const;
</script>
{#if items.length}
  <aside class="notification-stack" aria-label="Notifications" bind:this={panel}>
    <div class="notice-list">
      {#each items as item (item.id)}
        <section class="notification-sheet" data-notice-id={item.id} data-notice-kind={item.kind} aria-label={`${KIND[item.kind]} notification: ${item.title}`}>
          <header class="notification-heading">
            <h2 class="notification-title" title={item.title}>{item.title}</h2>
            {#if item.status}{@render item.status()}{/if}
          </header>
          <div class="notification-body">
            {@render item.children()}
            {#if errors[item.id]}<p role="alert">{errors[item.id]}</p>{/if}
          </div>
          <footer>
            {#if item.action}<button onclick={() => settle(item.id, item.action?.run)} disabled={clearing.includes(item.id)}>{item.action.label}</button>{/if}
            {#if item.onopen}<button onclick={() => void item.onopen?.()}>Open conversation</button>{/if}
            {#if item.hasInput}<button onclick={() => enterInput(item.id)}>Add note</button>{/if}
            <button onclick={() => clear(item.id)} disabled={clearing.includes(item.id)} aria-label={`Clear ${item.title}`}>Clear</button>
          </footer>
        </section>
      {/each}
    </div>
  </aside>
{/if}
<style>
  .notification-stack { position:fixed; top:88px; right:16px; z-index:125; width:460px; max-width:calc(100vw - 32px); max-height:calc(100dvh - 112px); display:flex; flex-direction:column; gap:8px; }
  .notice-list { overflow:auto; padding:3px; margin:-3px; display:flex; flex-direction:column; gap:12px; }
  .notification-sheet { flex:none; outline:none; }
  button { border:0; background:none; color:var(--text-strong); font:var(--type-meta); cursor:pointer; }
  footer button { padding:0; color:inherit; }
  footer button:hover { text-decoration:underline; }
  footer button:disabled { opacity:.4; cursor:default; }
  footer { display:flex; flex-wrap:wrap; gap:8px 18px; padding:0 20px 12px; color:var(--text-muted); font:var(--type-meta); }
</style>
