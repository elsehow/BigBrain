<script lang="ts">
  import { routeHistory, navigateHistory } from '../lib/routeHistory.svelte';
  const available = $derived(routeHistory);
  function go(direction: 'back' | 'forward') { navigateHistory(direction); }
  function activate(e: KeyboardEvent, direction: 'back' | 'forward') {
    if (e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation(); go(direction);
  }
</script>
<nav class="note-history" aria-label="Navigation history">
  <button class:unavailable={!available.back} disabled={!available.back} onclick={() => go('back')} onkeydown={e => activate(e, 'back')} aria-label="Go back" aria-keyshortcuts="h"><span class="history-arrow" aria-hidden="true">←</span> <kbd class="keyboard-hint">h</kbd></button>
  <button class:unavailable={!available.forward} disabled={!available.forward} onclick={() => go('forward')} onkeydown={e => activate(e, 'forward')} aria-label="Go forward" aria-keyshortcuts="l"><span class="history-arrow" aria-hidden="true">→</span> <kbd class="keyboard-hint">l</kbd></button>
</nav>
<style>
  nav { display:flex; align-items:center; gap:18px; min-height:16px; color:var(--text-muted); font:500 10.5px/1.5 var(--font-mono); letter-spacing:.13em; text-transform:uppercase; }
  button { display:inline-flex; align-items:center; gap:6px; padding:0; border:0; background:none; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }
  button:not(:disabled):hover { color:var(--text-strong); }
  button:focus-visible { outline:1px solid var(--text-strong); outline-offset:4px; }
  .unavailable { opacity:.3; cursor:default; }
  .history-arrow { font:400 22px/16px var(--font-app); letter-spacing:0; }
  kbd { font:inherit; color:var(--text-strong); }
</style>
