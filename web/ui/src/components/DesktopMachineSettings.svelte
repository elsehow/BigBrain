<script lang="ts">
  // Settings › Desktops: contained desktops' machines
  // (docs/plans/2026-10-12-contained-desktops.md, "What the person sees").
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import type { DesktopMachines } from "../lib/types";
  let m = $state<DesktopMachines | null>(null);
  let busy = $state(true), error = $state(false), notice = $state("");
  onMount(async () => { try { m = await api.desktopMachines(); } catch { notice = "Could not load the desktop machines."; error = true; } finally { busy = false; } });
  async function save(patch: { memoryGiB?: number; running?: number }) {
    busy = true; error = false;
    try { m = await api.saveDesktopMachines(patch); notice = "Saved; a machine takes it at its next start"; }
    catch (e) { notice = e instanceof Error ? e.message : "Could not save."; error = true; }
    finally { busy = false; }
  }
  async function prune() {
    busy = true; error = false;
    try { const r = await api.pruneDesktopMachines(); m = r; notice = r.freed ? `Freed ${mb(r.freed)}` : "Nothing unused to delete"; }
    catch (e) { notice = e instanceof Error ? e.message : "Could not delete."; error = true; }
    finally { busy = false; }
  }
  const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
</script>
<section aria-label="Desktop machines" class="machine-settings">
  <h3>Desktop machines</h3>
  {#if m && !m.available}
    <p>{m.why}</p>
  {:else if m}
    <p>Each desktop works in a small machine of its own: what it runs can't reach your files, and it reaches the internet only through BigBrain's proxy.</p>
    <label class="row">Memory per desktop
      <select disabled={busy} value={m.memoryGiB} onchange={e => void save({ memoryGiB: Number((e.currentTarget as HTMLSelectElement).value) })}>
        {#each m.memoryChoices as g (g)}<option value={g}>{g} GB</option>{/each}
      </select></label>
    <label class="row">Running at once
      <select disabled={busy} value={m.running} onchange={e => void save({ running: Number((e.currentTarget as HTMLSelectElement).value) })}>
        {#each m.runningChoices as n (n)}<option value={n}>{n}</option>{/each}
      </select></label>
    <p class="hint">Starting one more stops the one idle longest.</p>
    {#if m.image}
      <div class="row image"><span>Machine image</span>
        <span class="value">{m.image.local ? "a local build" : m.image.missing ? `downloads on first use (${mb(m.image.missing)})` : `here, ${mb(m.image.imageBytes)}`}{m.image.diskBytes ? ` · desktops' disks ${mb(m.image.diskBytes)}` : ""}</span>
        <button disabled={busy} onclick={() => void prune()} title="Delete machine images no desktop came from">Delete unused</button></div>
    {/if}
  {/if}
  {#if notice}<p role={error ? "alert" : "status"} class="notice">{notice}</p>{/if}
</section>
<style>
  .machine-settings { display:flex; flex-direction:column; gap:13px; max-width:680px; }
  h3 { font:var(--type-heading); letter-spacing:var(--ls-heading); color:var(--text-strong); margin:0; }
  p { font:var(--type-body); color:var(--text-note); margin:0; }
  .hint { font:var(--type-meta); }
  .row { display:flex; flex-wrap:wrap; align-items:center; gap:14px; padding:10px 0; border-bottom:1px solid var(--rule); font:var(--type-body); color:var(--text-strong); justify-content:space-between; }
  .image .value { margin-right:auto; font:var(--type-meta); color:var(--text-note); }
  select { font:var(--type-body); color:var(--fg); background:var(--well); border:1px solid var(--rule); padding:6px 8px; border-radius:var(--r-sm); }
  button { font:var(--type-meta); color:var(--text-strong); background:none; border:0; cursor:pointer; padding:7px 0; }
  .notice { font:var(--type-meta); color:var(--activity); }
  button:focus-visible, select:focus-visible { outline:2px solid var(--activity); outline-offset:3px; }
</style>
