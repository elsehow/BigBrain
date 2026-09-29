<script lang="ts">
  import { onMount } from 'svelte';
  import { selectedWorkspace, switchWorkspace } from '../lib/vaultScope';
  import { sharedWorkspace } from '../lib/sharedWorkspace.svelte';
  import { tooltip } from '../lib/tooltip';
  let connections = $state<Array<{ id: string; name: string }>>([]);
  let open = $state(false), connecting = $state(false), busy = $state(false), error = $state('');
  let name = $state(''), endpoint = $state(''), token = $state('');
  onMount(async () => { try { const r = await globalThis.fetch('/api/shared-connections'); if (r.ok) connections = (await r.json()).connections; } catch { error = 'Could not load connections.'; } });
  async function connect(event: SubmitEvent) {
    event.preventDefault(); busy = true; error = '';
    try {
      const response = await globalThis.fetch('/api/shared-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, endpoint, token }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      token = ''; switchWorkspace(data.id);
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
<div class="vault-switcher">
  <button class="current" aria-expanded={open} onclick={() => open = !open} use:tooltip={"Switch vault"}>{selectedWorkspace ? sharedWorkspace.name || connections.find(c => c.id === selectedWorkspace)?.name || 'Shared vault' : 'Personal vault'} <span aria-hidden="true">⌄</span></button>
  {#if open}
    <div class="vault-menu" role="dialog" tabindex="-1" aria-label="Vaults" onkeydown={e => { e.stopPropagation(); if (e.key === "Escape") { open = false; token = ""; } }}>
      <button onclick={() => switchWorkspace(null)}>Personal vault</button>
      {#each connections as connection}<button onclick={() => switchWorkspace(connection.id)} aria-current={selectedWorkspace === connection.id ? 'true' : undefined}>{connection.name}</button>{/each}
      <button onclick={() => connecting = !connecting}>Connect shared vault…</button>
      {#if selectedWorkspace && sharedWorkspace.ready}<p>{sharedWorkspace.display} · {sharedWorkspace.role} · {sharedWorkspace.writable ? 'read and write' : 'read only'}</p>{/if}
      {#if connecting}
        <form onsubmit={connect}>
          <label>Name<input bind:value={name} required maxlength="100" /></label>
          <label>Server address<input bind:value={endpoint} type="url" placeholder="https://vault.example.org" required /></label>
          <label>Member credential<input bind:value={token} type="password" autocomplete="off" required /></label>
          <button type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
        </form>
      {/if}
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
  form { border-top: 1px solid var(--rule); padding: 12px 10px; display: grid; gap: 12px; }
  label { display: grid; gap: 6px; } input { min-width: 0; width: 100%; box-sizing: border-box; background: transparent; color: var(--text); border: 1px solid var(--rule); padding: 8px; font: inherit; }
</style>
