<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { untrack } from "svelte";
  import { hasExternalOpener, openExternal } from "../lib/native";
  import { setupStatus, type SetupState, type SubscriptionStatus, type SubscriptionProvider } from "../lib/setup";
  import { app } from "../lib/store.svelte";
  import { SUBSCRIPTION_PROVIDERS } from "../../../../lib/providerConnection";
  let { setup, provider, onChange, compact = false }: { setup: SetupState; provider: SubscriptionProvider; compact?: boolean; onChange?: (s: SetupState) => void } = $props();
  const name = $derived(SUBSCRIPTION_PROVIDERS[provider].label);
  let status = $state<SubscriptionStatus>({ connected: false, phase: "idle" });
  let busy = $state(false);
  let problem = $state("");
  let callback = $state("");
  let browser: Window | null = null;
  let opened = "";
  const pending = $derived(["starting", "browser", "finishing"].includes(status.phase));
  $effect(() => { const next = setup[provider]; if (next) untrack(() => { if (!pending) status = next; }); });
  async function accept(next: SubscriptionStatus) {
    const newlyConnected = next.connected && !status.connected;
    status = next;
    if (next.url && next.url !== opened) {
      opened = next.url;
      if (hasExternalOpener()) openExternal(next.url);
      else if (browser && !browser.closed) { browser.location.href = next.url; browser = null; }
    }
    if (newlyConnected) {
      const nextSetup = await setupStatus();
      if (nextSetup) { setup = nextSetup; onChange?.(nextSetup); app.rev++; }
    }
  }
  async function act(action: "login" | "cancel" | "callback") {
    if (busy) return;
    busy = true; problem = "";
    if (action === "login" && !status.retrySetup) {
      // Open synchronously from the click to avoid popup blocking while the
      // local service prepares OAuth. The normal link remains a fallback.
      browser = hasExternalOpener() ? null : window.open("about:blank", "_blank");
      if (browser) browser.opener = null;
      opened = "";
    }
    try {
      const response = await fetch(`/api/setup/${provider}/${action}`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "callback" ? { url: callback } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Could not connect ${name}.`);
      if (action === "callback") callback = "";
      if (action === "cancel") { browser?.close(); browser = null; }
      await accept(result);
    } catch (e) { problem = e instanceof Error ? e.message : String(e); browser?.close(); browser = null; }
    finally { busy = false; }
  }
  $effect(() => {
    if (!pending) return;
    let stopped = false, checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(`/api/setup/${provider}`);
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (!stopped) { problem = ""; await accept(next); }
      } catch { if (!stopped) problem = "Could not check sign-in. Retrying…"; }
      finally { checking = false; }
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  });
</script>

<div class="connection" aria-label={`${name} connection`}>
  <div class="heading"><h3>{name}</h3><span class="status" class:live={status.connected}>{status.connected ? "Connected" : pending ? "Connecting…" : status.phase === "error" ? "Setup incomplete" : "Not connected"}</span></div>
  {#if !status.connected && pending}
    <p role="status">{status.phase === "starting" ? "Preparing sign-in…" : status.phase === "finishing" ? "Finishing connection…" : `Finish signing in with ${name} in your browser.`}</p>
    <div class="actions">
      {#if status.url}<a href={status.url} target="_blank" rel="noreferrer" onclick={e => { e.preventDefault(); openExternal(status.url!); }}>Continue with {name}</a>{/if}
      <button disabled={busy} onclick={() => act("cancel")}>Cancel</button>
    </div>
    {#if status.manualCode}
      <details>
        <summary>Browser didn’t return?</summary>
        <p>If your browser cannot reach the final page, paste its complete URL here.</p>
        <label>Callback URL <input type="text" autocomplete="off" spellcheck="false" bind:value={callback} /></label>
        <button disabled={busy || !callback.trim()} onclick={() => act("callback")}>Finish connection</button>
      </details>
    {/if}
  {:else if !status.connected}
    {#if !compact}<p>Use your {name} subscription for your pilot and gardener.</p>{/if}
    <button class="primary" disabled={busy} onclick={() => act("login")}>{status.phase === "error" ? status.retrySetup ? "Retry setup" : "Try again" : `Connect ${name}`}</button>
  {/if}
  {#if problem || status.problem}<p class="problem" role="alert">{problem || status.problem}</p>{/if}
</div>

<style>
  .connection { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-3); }
  h3, p { margin: 0; }
  h3 { font: var(--type-heading); color: var(--text-strong); }
  p, details { font: var(--type-meta); color: var(--text-muted); }
  .heading { display: flex; width: 100%; justify-content: space-between; align-items: baseline; gap: var(--sp-4); }
  .status { font: var(--type-meta); color: var(--text-muted); }
  .status.live { color: var(--accent-3); }
  .actions { display: flex; align-items: center; gap: var(--sp-3); }
  button, a { font: var(--type-body); cursor: pointer; }
  button { border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--text-strong); padding: var(--sp-2) var(--sp-3); }
  button.primary { background: var(--text-strong); color: var(--bg); }
  button:disabled { opacity: .5; cursor: default; }
  a { color: var(--text-strong); }
  label { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-2) 0; }
  input { width: 100%; min-width: 240px; }
  .problem { color: var(--text-strong); }
</style>
