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
  // The stack holds the window's top-right corner, under the strips above
  // the top bar (`below`, their height), so what would sit under it makes
  // room instead (#167: it covered Settings' Configure, and every control
  // down Settings' right side). It publishes its footprint on the root:
  // --notice-foot is how far down it reaches. Where the window leaves
  // Settings a working width beside it, --notice-lane is the column it holds
  // (Settings widens into it, a chat keeps left of it); narrower,
  // --notice-band is the foot again, and what opens under the strip starts
  // below the stack.
  let { below = 0 }: { below?: number } = $props();
  const LANE_FROM = 1152; // the 492px column, and Settings' rail beside a 400px list
  let width = $state(0), height = $state(0), innerWidth = $state(0);
  const top = $derived(Math.max(88, below + 16));
  $effect(() => {
    if (!items.length || !panel) return;
    const root = document.documentElement.style, foot = `${top + height + 16}px`;
    const footprint = { '--notice-foot': foot, ...(innerWidth >= LANE_FROM ? { '--notice-lane': `${width + 32}px` } : { '--notice-band': foot }) };
    for (const [name, value] of Object.entries(footprint)) root.setProperty(name, value);
    return () => { for (const name of Object.keys(footprint)) root.removeProperty(name); };
  });
</script>
<svelte:window bind:innerWidth />
{#if items.length}
  <aside class="notification-stack" aria-label="Notifications" style:--top={`${top}px`} bind:this={panel} bind:offsetWidth={width} bind:offsetHeight={height}>
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
  /* at most half the window, and never down into the field's bottom 230px
     (the feed, the key hints, Feedback, a chat's message box) */
  .notification-stack { position:fixed; top:var(--top); right:16px; z-index:125; width:460px; max-width:calc(100vw - 32px); max-height:min(50dvh, calc(100dvh - var(--top) - 230px)); display:flex; flex-direction:column; gap:8px; }
  .notice-list { overflow:auto; padding:3px; margin:-3px; display:flex; flex-direction:column; gap:12px; }
  .notification-sheet { flex:none; outline:none; }
  button { border:0; background:none; color:var(--text-strong); font:var(--type-meta); cursor:pointer; }
  footer button { padding:0; color:inherit; }
  footer button:hover { text-decoration:underline; }
  footer button:disabled { opacity:.4; cursor:default; }
  footer { display:flex; flex-wrap:wrap; gap:8px 18px; padding:0 20px 12px; color:var(--text-muted); font:var(--type-meta); }
</style>
