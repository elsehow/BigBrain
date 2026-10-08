<script lang="ts">
  // Integration accounts whose sign-in lapsed (it can no longer renew): ONE
  // persistent notice, with the fix, until each is signed in again or the
  // notice is cleared. One such account is named, with Reconnect; several are
  // listed, with the way to Integrations. Its card says "Needs reconnecting"
  // either way.
  import { onMount } from "svelte";
  import { vaultFetch as fetch } from "../lib/vaultScope";
  import { openExternal } from "../lib/native";
  import { goto } from "../lib/store.svelte";
  import StackNotice from "./StackNotice.svelte";
  type Account = { name: string; account: string; label: string; identity?: unknown; reconnect?: boolean; noticeCleared?: boolean; unavailable?: string; auth?: { phase: string; url?: string } };
  type Listing = { library?: { id: string; name: string }[]; accounts: Account[] };
  let lapsed = $state<(Account & { title: string })[]>([]);
  const only = $derived(lapsed.length === 1 ? lapsed[0] : undefined);
  /** Up to three names, then how many more. */
  const names = $derived.by(() => {
    const shown = lapsed.slice(0, 3).map(a => a.title), more = lapsed.length - shown.length;
    return more ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown.join("");
  });
  /** The account under its integration's name, as its card names it: "Hardcover · reader". */
  function titled(v: Listing, a: Account): string {
    const integration = v.library?.find(l => l.id === a.name)?.name ?? a.name;
    const identity = a.identity as { email?: unknown; username?: unknown } | undefined;
    const who = a.label !== a.name ? a.label : typeof identity?.email === "string" ? identity.email : typeof identity?.username === "string" ? identity.username : "";
    return who ? `${integration} · ${who}` : integration;
  }
  async function request(body?: unknown): Promise<Listing> {
    const r = await fetch("/api/integration-accounts", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "Could not load account settings.");
    return v;
  }
  let signingIn = false;
  function accept(v: Listing): Listing {
    const rows = v.accounts.filter(a => a.reconnect && !a.noticeCleared);
    signingIn = rows.some(a => a.auth?.phase === "browser" || a.auth?.phase === "starting");
    lapsed = rows.map(a => ({ ...a, title: titled(v, a) }));
    return v;
  }
  /** As the card's Reconnect: start the sign-in, then open it in the browser. */
  async function reconnect(a: Account) {
    const v = accept(await request({ name: a.name, account: a.account, action: "connect" }));
    const url = v.accounts.find(x => x.name === a.name && x.account === a.account)?.auth?.url;
    if (url) await openExternal(url);
  }
  async function dismiss(accounts: Account[]) {
    try { for (const a of accounts) await request({ name: a.name, account: a.account, action: "dismiss" }); }
    finally { accept(await request()); }
  }
  onMount(() => {
    let last = 0;
    // every 30s, or every 1.5s while a sign-in it started is under way
    const refresh = () => {
      if (document.visibilityState !== "visible" || (!signingIn && Date.now() - last < 30_000)) return;
      last = Date.now();
      void request().then(accept).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  });
</script>

{#if lapsed.length}
  <StackNotice id="integration:reconnect" title={only ? only.title : "Integrations need reconnecting"} kind="connection"
    action={only && !only.unavailable ? { label: "Reconnect", run: () => reconnect(only) } : { label: "Open Integrations", run: () => goto("integrations") }}
    onclear={() => dismiss(lapsed)}>
    {#snippet status()}<span class="state">needs reconnecting</span>{/snippet}
    {#if only}<p>Needs reconnecting. BigBrain can no longer renew this sign-in, so agents can’t read the account until you sign in again.</p>
    {:else}<p>{names}. BigBrain can no longer renew these sign-ins; reconnect each in Settings → Integrations.</p>{/if}
  </StackNotice>
{/if}

<style>
  .state { font: var(--type-meta); color: inherit; white-space: nowrap; }
  p { margin: 0; font: var(--type-body); }
</style>
