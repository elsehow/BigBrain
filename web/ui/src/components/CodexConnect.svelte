<script lang="ts">
  import AgentConnection from "./AgentConnection.svelte";
  import { codexAction, setupStatus, type SetupState } from "../lib/setup";
  import { app } from "../lib/store.svelte";
  let { setup, onChange, compact = false }: { setup: SetupState; compact?: boolean; onChange?: (s: SetupState) => void } = $props();
  let busy = $state(false);
  let problem = $state("");
  let loginUrl = $state("");
  let installing = $state(false);
  const installingNow = $derived(installing || !!setup.codex?.connectionStage);
  const progress = $derived(!installingNow ? "" : setup.codex?.connectionStage === "plugin" ? "Installing plugin…" : setup.codex?.connectionStage === "saving" ? "Saving connection…" : "Connecting…");
  async function act(action: "connect" | "plugin" | "login" | "login/cancel") {
    if (busy) return;
    busy = true; problem = "";
    installing = action === "connect" || action === "plugin";
    try {
      const result = await codexAction(action);
      if (action === "login") loginUrl = result.url;
      else if (action === "login/cancel") loginUrl = "";
      else { setup = result; onChange?.(result); app.rev++; }
    } catch (e) { problem = e instanceof Error ? e.message : String(e); }
    finally { busy = false; installing = false; }
  }
  $effect(() => {
    if (!loginUrl && !installingNow) return;
    const timer = setInterval(async () => { const next = await setupStatus().catch(() => null); if (next) { setup = next; onChange?.(next); } }, 3000);
    return () => clearInterval(timer);
  });
  $effect(() => { if (setup.codex?.account !== null) loginUrl = ""; });
</script>

<AgentConnection name="Codex" version={setup.codex?.installed}
  signedIn={setup.codex?.account !== null && setup.codex?.account !== undefined}
  supported={setup.codex?.supported !== false} connected={setup.codex?.connected}
  plugin={setup.codex?.plugin} {compact} {progress} {problem}
  onConnect={() => act("connect")}
  installCommand="npm install -g @openai/codex@latest">
  {#snippet signin()}
    <div class="signin">
      {#if loginUrl}
        <a class="agent-primary" href={loginUrl} target="_blank" rel="noreferrer">Continue with ChatGPT</a>
        <button class="agent-cancel" disabled={busy} onclick={() => act("login/cancel")}>Cancel</button>
      {:else}
        <button class="agent-primary" disabled={busy} onclick={() => act("login")}>{busy ? "Starting sign-in…" : "Sign in with ChatGPT"}</button>
      {/if}
    </div>
  {/snippet}
  {#snippet after()}
    {#if setup.codex?.connected}<p>Enable memory preload: approve BigBrain in Codex <code>/hooks</code>.</p>{/if}
  {/snippet}
</AgentConnection>

<style>
  .signin { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  p { margin: 0; font: var(--type-meta); color: var(--text-muted); }
  code { font: var(--type-mono); }
</style>
