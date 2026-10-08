<script lang="ts">
  // The base's one word on usage credits (lib/providerCredits.ts): which
  // provider ran out, what that paused, and that nothing is lost. It stays
  // until credits return, in the update banner's slot (TopStrips) in every
  // view; Retry clears the marks so the paused jobs try again now.
  import { app } from "../lib/store.svelte";
  import { vaultFetch as fetch } from "../lib/vaultScope";

  type Mark = { since: string; at: string; roles: string[]; detail: string };
  let providers = $state<Record<string, Mark>>({});
  let busy = $state(false);

  const PROVIDER: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "ChatGPT", openai: "OpenAI", typesafe: "Jev", google: "Google" };
  const ROLE: Record<string, string> = { tend: "filing", gardener: "filing", memory: "memory", quick: "summaries", feed: "the feed", firewall: "new arrivals", gate: "the worth gate", inclusion: "inclusion rules", pilot: "Pilot", voice: "Pilot voice" };
  const named = (p: string) => PROVIDER[p] ?? p;
  const paused = (m: Mark) => [...new Set(m.roles.map((r) => ROLE[r] ?? r))].join(", ");

  async function load(): Promise<void> {
    try { const r = await fetch("/api/credits"); if (r.ok) providers = (await r.json()).providers ?? {}; } catch { /* an older engine has no route */ }
  }
  $effect(() => { void app.creditsRev; void app.live; void load(); });
  async function retry(): Promise<void> {
    busy = true;
    try { const r = await fetch("/api/credits/retry", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); if (r.ok) providers = (await r.json()).providers ?? {}; }
    finally { busy = false; }
  }
</script>

{#if Object.keys(providers).length}
  <div class="credits" role="alert">
    {#each Object.entries(providers) as [p, m] (p)}
      <span title={m.detail}><b>Out of usage credits with {named(p)}.</b> Paused: {paused(m)}. Nothing is lost; it picks up when credits return.</span>
    {/each}
    <button type="button" disabled={busy} onclick={() => void retry()}>{busy ? "Retrying…" : "Retry"}</button>
  </div>
{/if}

<style>
  /* the update banner's strip (UpdateNudge), in the error's colour */
  .credits { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px var(--sp-4);
    padding: 9px var(--app-gutter); font: var(--type-meta); color: var(--text);
    background: color-mix(in srgb, var(--err, #c33) 11%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, var(--err, #c33) 24%, transparent); }
  span { display: block; }
  b { font-weight: 600; }
  button { flex: none; margin-left: auto; font: var(--type-chip); color: var(--text-strong); cursor: pointer;
    background: color-mix(in srgb, var(--err, #c33) 20%, var(--bg)); border: none; border-radius: var(--r-chip); padding: 5px 12px; }
  button:hover { background: color-mix(in srgb, var(--err, #c33) 30%, var(--bg)); }
  button:disabled { opacity: .5; cursor: default; }
</style>
