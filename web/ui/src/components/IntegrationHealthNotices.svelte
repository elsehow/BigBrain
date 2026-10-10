<script lang="ts">
  // Integrations that stopped syncing: ONE persistent notice, with the way to
  // Integrations, when a poll needs the person (a rejected key) or has failed
  // for hours. A lapsed sign-in is IntegrationReconnectNotices' to raise, not
  // this one's. Clearing it quiets this run of failures; the next run is
  // noticed afresh.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { vaultStorageKey } from "../lib/vaultScope";
  import { goto } from "../lib/store.svelte";
  import type { IntegrationInfo } from "../lib/types";
  import StackNotice from "./StackNotice.svelte";
  type Failing = { title: string; label: string; checkedAt?: string; key: string };
  const HOURS = 6;
  // read when used, not at load: the vault's storage key settles after the first request
  const storageKey = () => vaultStorageKey("integration-health:cleared");
  const NAMES: Record<string, string> = { granola: "Granola", "that-tracks": "That Tracks" };
  let rows = $state<Failing[]>([]);
  let cleared = $state<string[]>([]);
  const failing = $derived(rows.filter(r => !cleared.includes(r.key)));
  const only = $derived(failing.length === 1 ? failing[0] : undefined);
  const names = $derived.by(() => {
    const shown = failing.map(f => f.title);
    return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown.join("");
  });
  function read(): string[] {
    try { const v = JSON.parse(localStorage.getItem(storageKey()) ?? "[]"); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function clear() {
    cleared = [...new Set([...cleared, ...failing.map(f => f.key)])].slice(-20);
    try { localStorage.setItem(storageKey(), JSON.stringify(cleared)); } catch { /* cleared for this session only */ }
  }
  function accept(integrations: IntegrationInfo[], now = Date.now()) {
    rows = integrations.flatMap(i => {
      const s = i.status;
      if (s?.state !== "error" || s.code === "reconnect" || !s.failingSince) return [];
      if (!s.needsAction && now - Date.parse(s.failingSince) < HOURS * 3_600_000) return [];
      return [{ title: NAMES[i.name] ?? i.name, label: s.label, checkedAt: s.checkedAt, key: `${i.name}:${s.failingSince}` }];
    });
  }
  const since = (at?: string) => at ? `Last synced ${new Date(at).toLocaleString()}.` : "It hasn’t synced yet.";
  onMount(() => {
    const refresh = () => { if (document.visibilityState === "visible") void api.config().then(c => { cleared = read(); accept(c.integrations); }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  });
</script>

{#if failing.length}
  <StackNotice id="integration:health" title={only ? `${only.title} isn’t syncing` : "Integrations aren’t syncing"} kind="connection"
    action={{ label: "Open Integrations", run: () => goto("integrations") }} onclear={clear}>
    {#snippet status()}<span class="state">not syncing</span>{/snippet}
    {#if only}<p>{only.label} {since(only.checkedAt)}</p>
    {:else}<p>{names}. See each in Settings → Integrations.</p>{/if}
  </StackNotice>
{/if}

<style>
  .state { font: var(--type-meta); color: inherit; white-space: nowrap; }
  p { margin: 0; font: var(--type-body); }
</style>
