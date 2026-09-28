<script lang="ts">
  import type { Snippet } from "svelte";
  let { name, version, signedIn = false, supported = true, connected = false,
    plugin = null, account = "", compact = false, installCommand, signin, after,
    onConnect, onUpdate, progress = "", problem = "" }: {
    name: string; version?: string | false; signedIn?: boolean; supported?: boolean;
    connected?: boolean; plugin?: string | null; account?: string; compact?: boolean;
    installCommand: string; signin?: Snippet; after?: Snippet;
    onConnect?: () => Promise<void> | void; onUpdate?: () => Promise<void> | void;
    progress?: string; problem?: string;
  } = $props();
  const ready = $derived(!!version && signedIn && supported);
  const status = $derived(version === undefined ? "Status unavailable" : !version ? "Not installed" : !supported ? "Update required" : !signedIn ? "Sign in required" : connected ? "Connected" : "Not connected");
  let busy = $state(false);
  async function act(update: boolean) {
    if (busy || progress) return;
    busy = true;
    try { await (update ? onUpdate?.() : onConnect?.()); }
    finally { busy = false; }
  }
</script>

<div class="agent">
  <div class="heading">
    <span class="name">{name}</span>
    <span class="status" class:live={ready && connected}>{status}</span>
  </div>
  {#if ready && account}<p class="detail">{account}</p>{/if}
  {#if version === false || !supported}
    <code>{installCommand}</code>
  {:else if version && !signedIn}
    {@render signin?.()}
  {/if}
  {#if ready}
    {#if !compact && !connected}
      <p class="detail">Connect to use your {name} subscription in BigBrain.</p>
    {/if}
    {#if !connected || onUpdate}
      <div class="actions">
        <button class:secondary={connected} disabled={busy || !!progress}
          onclick={() => act(connected)}>{progress || (busy ? (connected ? "Updating…" : "Connecting…") : connected ? "Update plugin" : "Connect")}</button>
        {#if plugin}<span class="detail">Plugin {plugin}</span>{/if}
      </div>
    {/if}
    {@render after?.()}
  {/if}
  {#if problem}<p role="alert">{problem}</p>{/if}
</div>

<style>
  .agent { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-3); }
  .heading { display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: var(--sp-4); }
  .name { font: var(--type-heading); color: var(--text-strong); }
  .status, .detail { font: var(--type-meta); color: var(--text-muted); }
  .status.live { color: var(--accent-3); }
  p { margin: 0; }
  code { font: var(--type-mono); overflow-wrap: anywhere; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
  button, .agent :global(.agent-primary) { font: var(--type-chip); font-weight: 600; padding: 9px 16px;
    border: 1px solid var(--text-strong); border-radius: var(--r-sm); background: var(--text-strong);
    color: var(--bg); cursor: pointer; text-decoration: none; }
  button.secondary { background: transparent; color: var(--text-strong); border-color: var(--rule); }
  button:disabled, .agent :global(button:disabled) { opacity: .45; cursor: default; }
  .agent :global(.agent-cancel) { font: var(--type-meta); background: none; border: none; color: var(--text-muted); text-decoration: underline; cursor: pointer; }
  [role=alert] { font: var(--type-meta); color: var(--accent-2); }
</style>
