<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import type { DesktopNetwork } from "../lib/types";
  let defaults = $state<string[]>([]), hosts = $state<string[]>([]);
  let busy = $state(true), error = $state(false), notice = $state("");
  let adding = $state(false), host = $state("");
  function load(n: DesktopNetwork) { defaults = n.defaults; hosts = n.hosts; }
  onMount(async () => { try { load(await api.desktopNetwork()); } catch { notice = "Could not load the desktop network."; error = true; } finally { busy = false; } });
  async function save(next: string[]) {
    busy = true; error = false;
    try { load(await api.saveDesktopNetwork(next)); notice = "Saved"; return true; }
    catch (e) { notice = e instanceof Error ? e.message : "Could not save the desktop network."; error = true; return false; }
    finally { busy = false; }
  }
  async function add() {
    const value = host.trim().toLowerCase();
    if (!value) return;
    if (hosts.includes(value) || defaults.includes(value)) { notice = "This host is already reachable."; return; }
    if (await save([...hosts, value])) { adding = false; host = ""; }
  }
</script>
<section aria-label="Always reachable" class="access-settings">
  <div class="head"><h3>Always reachable</h3><button disabled={busy} onclick={() => adding = !adding}>{adding ? "Cancel" : "+ Add host"}</button></div>
  <p>Desktops can always reach these items.</p>
  {#if adding}<form onsubmit={e => { e.preventDefault(); add(); }}><label>Host or local port<input placeholder="registry.example.com, *.example.com, localhost:5432" bind:value={host} /></label><button disabled={busy} class="save" type="submit">Allow</button></form>{/if}
  <!-- the built-in hosts are always allowed (lib/desktopNetwork.ts), so only added ones can go -->
  {#each defaults as h (h)}<div class="folder"><code>{h}</code></div>{/each}
  {#each hosts as h (h)}<div class="folder"><code>{h}</code><button disabled={busy} aria-label={`Remove ${h}`} onclick={() => void save(hosts.filter(x => x !== h))}>Remove</button></div>{/each}
  {#if notice}<p role={error ? "alert" : "status"} class="notice">{notice}</p>{/if}
</section>
<style>
  .access-settings { display:flex; flex-direction:column; gap:13px; max-width:680px; } h3 { font:var(--type-heading); letter-spacing:var(--ls-heading); color:var(--text-strong); margin:0; } p { font:var(--type-body); color:var(--text-note); margin:0; }
  .head { display:flex; justify-content:space-between; align-items:center; } button { font:var(--type-meta); color:var(--text-strong); background:none; border:0; cursor:pointer; padding:7px 0; } .folder { display:flex; flex-wrap:wrap; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid var(--rule); } code { margin-right:auto; font:var(--type-meta); font-family:var(--font-mono); overflow-wrap:anywhere; } input { font:var(--type-body); color:var(--fg); background:var(--well); border:1px solid var(--rule); padding:8px; border-radius:var(--r-sm); min-width:0; } form { display:flex; flex-wrap:wrap; gap:13px; align-items:end; } label { display:grid; gap:5px; font:var(--type-meta); } .save { background:var(--fg); color:var(--bg); padding:9px 12px; border-radius:var(--r-sm); } .notice { font:var(--type-meta); color:var(--activity); } button:focus-visible { outline:2px solid var(--activity); outline-offset:3px; }
</style>
