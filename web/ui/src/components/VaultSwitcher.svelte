<script lang="ts">
  import {openSharedInvite} from '../lib/sharedSettings.svelte';
  import { onMount } from 'svelte';
  import { selectedWorkspace, switchWorkspace } from '../lib/vaultScope';
  import { sharedWorkspace } from '../lib/sharedWorkspace.svelte';
  import { tooltip } from '../lib/tooltip';
  let connections = $state<Array<{ id: string; name: string }>>([]);
  let open = $state(false), error = $state('');
  onMount(async () => { try { const r = await globalThis.fetch('/api/shared-connections'); if (r.ok) connections = (await r.json()).connections; } catch { error = 'Could not load connections.'; } });
  function connect(){open=false;if(selectedWorkspace)location.href='/#sharedVaultSettings';else openSharedInvite();}
</script>
<div class="vault-switcher">
  <button class="current" aria-expanded={open} onclick={() => open = !open} use:tooltip={"Filter by vault"}>{selectedWorkspace ? sharedWorkspace.name || connections.find(c => c.id === selectedWorkspace)?.name || 'Shared vault' : 'All vaults'} <span aria-hidden="true">⌄</span></button>
  {#if open}
    <div class="vault-menu" role="dialog" tabindex="-1" aria-label="Vaults" onkeydown={e => { e.stopPropagation(); if (e.key === "Escape") { open = false; } }}>
      <button onclick={() => switchWorkspace(null)}>All vaults</button>
      {#each connections as connection}<button onclick={() => switchWorkspace(connection.id)} aria-current={selectedWorkspace === connection.id ? 'true' : undefined}>{connection.name}</button>{/each}
      <button onclick={connect}>Connect shared vault…</button>
      {#if selectedWorkspace && sharedWorkspace.ready}<p>{sharedWorkspace.display} · {sharedWorkspace.role} · {sharedWorkspace.writable ? 'read and write' : 'read only'}</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>
<style>
  .vault-switcher { position: relative; flex: none; font: var(--type-meta); color: var(--text); }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; text-align: left; }
  .current { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .vault-menu { position: absolute; top: 100%; left: 0; width: 300px; max-width: calc(100vw - 48px); background: var(--bg); border: 1px solid var(--rule); padding: 12px; z-index: 80; box-shadow: 0 8px 24px #0002; }
  .vault-menu > button { display: block; width: 100%; padding: 10px; }
  button:hover, button[aria-current=true] { background: var(--rule); }
  p { color: var(--text-muted); line-height: 1.5; padding: 0 10px; }
</style>
