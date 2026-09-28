<script lang="ts">
  import '../design/notification.css';
  import { onMount, tick, untrack } from 'svelte';
  import { navDelta, stepped, createListJump } from '../lib/listNav';
  const listJump = createListJump();
  import { editable } from '../lib/dom';
  import { notificationStack, notificationKeyboard } from '../lib/notificationStack.svelte';
  let panel: HTMLElement | undefined = $state();
  let selected = $state<string | null>(null);
  let selectedIndex = 0;
  let editing = $state(false);
  let returnTo: HTMLElement | null = null;
  let errors = $state<Record<string, string>>({});
  let clearing = $state<string[]>([]);
  const items = $derived(notificationStack.items);
  const rows = () => [...panel?.querySelectorAll<HTMLElement>('[data-notice-id]') ?? []];
  function focus(index: number) {
    const row = rows()[Math.max(0, Math.min(index, items.length - 1))];
    row?.focus(); row?.scrollIntoView({ block: 'nearest' });
  }
  function enterInput(id: string) {
    rows().find(row => row.dataset.noticeId === id)?.querySelector<HTMLInputElement>('input:not(:disabled), textarea:not(:disabled)')?.focus();
  }
  function leave() {
    selected = null;
    if (returnTo?.isConnected) returnTo.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  function trackFocus(e: FocusEvent) {
    const target = e.target as HTMLElement;
    editing = editable(target);
    const row = target.closest<HTMLElement>('[data-notice-id]');
    if (row && panel?.contains(row)) {
      if (!selected) returnTo = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
      selected = row.dataset.noticeId!;
      selectedIndex = items.findIndex(item => item.id === selected);
    } else selected = null;
  }
  async function clear(id: string) {
    if (clearing.includes(id)) return;
    clearing = [...clearing, id];
    try { await items.find(item => item.id === id)?.onclear(); delete errors[id]; }
    catch (error) { errors[id] = (error as Error).message; }
    finally { clearing = clearing.filter(value => value !== id); }
  }
  // A note sent successfully can disappear asynchronously, too. Keep keyboard
  // focus on its neighbour, and return to the prior control when the stack empties.
  $effect(() => {
    const index = items.findIndex(item => item.id === selected);
    if (index >= 0) selectedIndex = index;
    if (selected && index < 0) {
      untrack(() => { void tick().then(() => { if (items.length) focus(selectedIndex); else leave(); }); });
    }
  });
  function key(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey && e.key !== 'G') return false;
    const inside = !!panel?.contains(document.activeElement);
    if (inside && e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (editable(e.target)) rows().find(row => row.dataset.noticeId === selected)?.focus();
      else leave();
      return true;
    }
    if (editable(e.target)) return false;
    if (e.key === 'n' && items.length) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!inside) { returnTo = document.activeElement as HTMLElement; focus(0); }
      else focus(selectedIndex);
      return true;
    }
    if (!inside || !selected) return false;
    // Once focused, navigation belongs to the stack rather than the graph.
    const jump = listJump(e);
    const delta = navDelta(e);
    const current = items.find(item => item.id === selected);
    if (jump || delta || e.key === 'c' || e.key === 'o' && current?.onopen || e.key === 'i' && current?.hasInput) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'i') enterInput(selected);
      else if (e.key === 'o') { if (!e.repeat) void current?.onopen?.(); }
      else if (e.key === 'c') { if (!e.repeat) void clear(selected); }
      else if (jump) { if (jump !== 'pending') focus(jump === 'first' ? 0 : items.length - 1); }
      else if (delta) focus(stepped(selectedIndex, delta, items.length));
      return true;
    }
    return false;
  }
  onMount(() => {
    notificationKeyboard.handle = key;
    document.addEventListener('focusin', trackFocus);
    return () => { notificationKeyboard.handle = () => false; document.removeEventListener('focusin', trackFocus); };
  });
</script>
{#if items.length}
  <aside class="notification-stack" aria-label="Notifications" bind:this={panel}>
    <button class="stack-focus" onclick={() => focus(0)} aria-keyshortcuts="n">Notifications <kbd>n</kbd></button>
    <div class="notice-list">
      {#each items as item (item.id)}
        <section class="notification-sheet" class:selected={selected === item.id} tabindex="-1" data-notice-id={item.id} data-notice-kind={item.kind} aria-label={`${item.kind === 'capture' ? 'Capture' : 'Agent'} notification: ${item.title}`} aria-keyshortcuts="c">
          <header class="notification-heading">
            <h2 class="notification-title" title={item.title}>{item.title}</h2>
            {#if item.status}{@render item.status()}{/if}
          </header>
          <div class="notification-body">
            {@render item.children()}
            {#if errors[item.id]}<p role="alert">{errors[item.id]}</p>{/if}
          </div>
          <footer>
            {#if selected === item.id && !editing}<span>j/k ↑/↓</span>{/if}
            {#if item.onopen}<button onclick={() => void item.onopen?.()} aria-keyshortcuts="o">Open conversation {#if selected === item.id && !editing}<kbd class="keyboard-hint">o</kbd>{/if}</button>{/if}
            {#if item.hasInput && !(selected === item.id && editing)}<button onclick={() => enterInput(item.id)} aria-keyshortcuts="i">Add note {#if selected === item.id && !editing}<kbd class="keyboard-hint">i</kbd>{/if}</button>{/if}
            <button onclick={() => clear(item.id)} disabled={clearing.includes(item.id)} aria-label={`Clear ${item.title}`} aria-keyshortcuts="c">Clear {#if selected === item.id && !editing}<kbd class="keyboard-hint">c</kbd>{/if}</button>
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
  .notification-sheet.selected { outline:2px solid var(--text-strong); outline-offset:2px; }
  button { border:0; background:none; color:var(--text-strong); font:var(--type-meta); cursor:pointer; }
  .stack-focus { align-self:flex-end; padding:4px 8px; background:var(--bg); border:1px solid var(--rule); }
  kbd { font:inherit; margin-left:6px; }
  footer button { padding:0; color:inherit; }
  footer button:hover { text-decoration:underline; }
  footer button:disabled { opacity:.4; cursor:default; }
  footer { display:flex; flex-wrap:wrap; gap:8px 18px; padding:0 20px 12px; color:var(--text-muted); font:var(--type-meta); }
</style>
