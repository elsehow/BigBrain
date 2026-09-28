<script lang="ts">
  import AgentAccessSettings from "./AgentAccessSettings.svelte";
  import CurationModel from "./CurationModel.svelte";
  import SubscriptionConnect from "./SubscriptionConnect.svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import ProviderUsage from "./ProviderUsage.svelte";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { type Notice } from "../lib/notice";
  import { setupStatus, type SetupState } from "../lib/setup";
  import type { UsageInfo } from "../lib/types";

  let adding = $state(false);
  let provider = $state("");
  let setup = $state<SetupState | null>(null);
  let setupLoaded = $state(false);
  let setupProblem = $state("");
  let notice = $state<Notice | null>(null);
  let usage = $state<UsageInfo | null>(null);
  const summary = $derived(setup ? `${Number(!!setup.chatgpt?.connected) + Number(!!setup.anthropic?.connected)} connected` : undefined);

  async function loadSetup() {
    try {
      setup = await setupStatus();
      setupProblem = setup?.chatgpt ? "" : "Provider login is available in the desktop app.";
    } catch { setupProblem = "Could not check connections. Retry."; }
    finally { setupLoaded = true; }
  }
  async function loadConfig() {
    usage = await api.usage().catch(() => null);
  }
  $effect(() => { void app.rev; void loadSetup(); });
  $effect(() => { void app.rev; void app.usageRev; void loadConfig(); });
  $effect(() => {
    const timer = setInterval(() => { void loadSetup(); void loadConfig(); }, 5000);
    return () => clearInterval(timer);
  });

</script>

<SettingsPage active="agents" title="MODELS" count={summary} {notice}>
  <div class="providers settings-list">
  <button class="settings-add" onclick={() => adding = !adding} aria-expanded={adding}>{adding ? 'Cancel' : 'New connection +'}</button>
  {#if adding}<div class="choices"><button onclick={() => { provider='chatgpt'; adding=false; }}>ChatGPT</button><button onclick={() => { provider='claude'; adding=false; }}>Claude</button></div>{/if}
  <h2>Provider login</h2>
  {#if setupProblem}<div class="problem" role="alert">{setupProblem} <button onclick={loadSetup}>Retry</button></div>{/if}
  {#if !setupLoaded}<p class="empty">Loading…</p>{/if}
  {#if setup}
    {#if setup.chatgpt && (setup.chatgpt.connected || provider === 'chatgpt')}
      <section class="settings-row item" aria-label="ChatGPT provider"><SubscriptionConnect provider="chatgpt" {setup} onChange={s => { setup = s; }} />
          {#if setup.chatgpt.connected}<ProviderUsage name="ChatGPT" monitor={usage?.providers?.["openai-codex"]} />{/if}
      </section>
    {/if}
    {#if setup.anthropic && (setup.anthropic.connected || provider === 'claude')}
      <section class="settings-row item" aria-label="Claude provider">
        <SubscriptionConnect provider="anthropic" {setup} onChange={s => { setup = s; }} />
        {#if setup.anthropic.connected}<ProviderUsage name="Claude" monitor={usage?.providers?.anthropic} />{/if}
      </section>
    {/if}
    {#if !setup.chatgpt?.connected && !setup.anthropic?.connected && !provider}<p class="empty">No connections yet.</p>{/if}
  {/if}
  </div>
  {#if setupLoaded}{#key `${!!setup?.chatgpt?.connected}:${!!setup?.anthropic?.connected}`}<CurationModel />{/key}{/if}
  <AgentAccessSettings />
</SettingsPage>

<style>
  h2 { font:var(--type-body); margin:0; }
  button { font:var(--type-body); padding:8px 12px; border:1px solid var(--rule); background:transparent; color:var(--text-strong); cursor:pointer; } .choices { display:flex; gap:12px; }
  .item { display: flex; flex-direction: column; gap: var(--sp-4); }
  .item :global(.heading) { justify-content: flex-start; gap: var(--sp-4); }
  .item :global(.heading h3), .item :global(.heading .name) { font: var(--type-body); }
  .item :global(.heading .status) { display: inline-flex; align-items: center; gap: 8px; }
  .item :global(.heading .status::before) { content: ""; width: 8px; height: 8px; border: 1px solid currentColor; border-radius: 50%; box-sizing: border-box; }
  .item :global(.heading .status.live::before) { background: var(--activity); border-color: var(--activity); }
  .problem, .empty { font: var(--type-meta); color: var(--text-muted); }
  .problem button { font: inherit; color: var(--text-strong); background: none; border: none; text-decoration: underline; cursor: pointer; }
</style>
