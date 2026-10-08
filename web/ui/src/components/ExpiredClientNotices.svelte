<script lang="ts">
  // Connected clients that lapsed (30 days unused) and were then tried: ONE
  // persistent notice, with the fix, until each is renewed, cleared or
  // disconnected. One such client is named, with Renew; several are listed,
  // with the way to Connected clients. A lapsed connection nobody tries stays
  // quiet; its card in Connected clients still says it expired.
  import { onMount } from "svelte";
  import { vaultFetch as fetch } from "../lib/vaultScope";
  import { goto } from "../lib/store.svelte";
  import StackNotice from "./StackNotice.svelte";
  type Client = { id: string; name: string; revoked: string | null; expired?: boolean; expiredUse?: string | null };
  let lapsed = $state<Client[]>([]);
  const only = $derived(lapsed.length === 1 ? lapsed[0] : undefined);
  /** Up to three names, then how many more. */
  const names = $derived.by(() => {
    const shown = lapsed.slice(0, 3).map(c => c.name), more = lapsed.length - shown.length;
    return more ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown.join("");
  });
  async function request(body?: unknown) {
    const r = await fetch("/api/connected-clients", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "Could not load clients.");
    return v;
  }
  async function load() { lapsed = ((await request()).clients as Client[]).filter(c => c.expired && c.expiredUse && !c.revoked); }
  async function act(action: "renew" | "dismiss", ids: string[]) {
    try { for (const id of ids) await request({ action, id }); }
    finally { await load(); }
  }
  onMount(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  });
</script>

{#if lapsed.length}
  <StackNotice id="connection:expired" title={only ? only.name : "BigBrain connections expired"} kind="connection"
    action={only ? { label: "Renew", run: () => act("renew", [only.id]) } : { label: "Open Connected clients", run: () => goto("connectedClients") }}
    onclear={() => act("dismiss", lapsed.map(c => c.id))}>
    {#snippet status()}<span class="state">expired</span>{/snippet}
    {#if only}<p>Expired after 30 days unused. A client tried to use it at {new Date(only.expiredUse!).toLocaleString()}. Renew to restore the same access; nothing changes in the client.</p>
    {:else}<p>{names}. Clients tried to use them; renew to restore the same access.</p>{/if}
  </StackNotice>
{/if}

<style>
  .state { font: var(--type-meta); color: inherit; white-space: nowrap; }
  p { margin: 0; font: var(--type-body); }
</style>
