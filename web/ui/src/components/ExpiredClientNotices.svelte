<script lang="ts">
  // A connected client that lapsed (30 days unused) and was then tried: one
  // persistent notice each, with the fix, until it is renewed, cleared or
  // disconnected. A lapsed connection nobody tries stays quiet; its card in
  // Connected clients still says it expired.
  import { onMount } from "svelte";
  import { vaultFetch as fetch } from "../lib/vaultScope";
  import StackNotice from "./StackNotice.svelte";
  type Client = { id: string; name: string; revoked: string | null; expired?: boolean; expiredUse?: string | null };
  let lapsed = $state<Client[]>([]);
  async function request(body?: unknown) {
    const r = await fetch("/api/connected-clients", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "Could not load clients.");
    return v;
  }
  async function load() { lapsed = ((await request()).clients as Client[]).filter(c => c.expired && c.expiredUse && !c.revoked); }
  async function act(action: "renew" | "dismiss", id: string) { await request({ action, id }); await load(); }
  onMount(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  });
</script>

{#each lapsed as client (client.id)}
  <StackNotice id={`client:${client.id}`} title={client.name} kind="connection" action={{ label: "Renew", run: () => act("renew", client.id) }} onclear={() => act("dismiss", client.id)}>
    {#snippet status()}<span class="state">expired</span>{/snippet}
    <p>Expired after 30 days unused. A client tried to use it at {new Date(client.expiredUse!).toLocaleString()}. Renew to restore the same access; nothing changes in the client.</p>
  </StackNotice>
{/each}

<style>
  .state { font: var(--type-meta); color: inherit; white-space: nowrap; }
  p { margin: 0; font: var(--type-body); }
</style>
