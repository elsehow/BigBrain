<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import type { PilotState } from "../lib/types";
  type Mode = "Read only";
  let folders = $state<{ path: string; mode: Mode }[]>([]);
  // Saved folders the engine now refuses (too broad, or holding credentials); they grant nothing.
  let removed = $state<{ path: string; reason: string }[]>([]);
  let busy = $state(true), error = $state(false);
  function load(s: PilotState) { folders = (s.permissions?.folders ?? []).map(f => ({ path: f.path, mode: "Read only" })); removed = s.permissions?.removed ?? []; }
  onMount(async () => { try { load(await api.pilot()); } catch { notice = "Could not load Pilot permissions."; error = true; } finally { busy = false; } });
  async function save(next = folders) {
    busy = true; error = false;
    try { load(await api.pilotPermissions({ version: 2, folders: next.map(f => ({ path: f.path, access: "read" })) })); notice = "Saved"; return true; }
    catch (e) { notice = e instanceof Error ? e.message : "Could not save Pilot permissions."; error = true; return false; }
    finally { busy = false; }
  }
  let adding = $state(false), path = $state(""), mode = $state<Mode>("Read only"), notice = $state("");
  async function add() {
    const value = path.trim().replace(/\/+$/, "");
    if (!value || !(value.startsWith("~/") || value.startsWith("/")) || value.split("/").includes("..")) { notice = "Enter an absolute path or a path starting with ~/."; return; }
    if (folders.some(f => f.path === value)) { notice = "This folder is already authorized."; return; }
    if (await save([...folders, { path: value, mode }])) { adding = false; path = ""; }
  }
</script>
<section aria-label="Pilot permissions" class="access-settings">
  <h3>Pilot permissions</h3>
  <p>Pilot can always read the vault. Optionally, you can add additional folders for it to read. (If you use Pilot to orchestrate agents, giving the Pilot access to, for example, your project folders can help the Pilot give orchestrated agents relevant context.)</p>
  <div class="folder-heading"><span>Authorized folders</span><button disabled={busy} onclick={() => adding = !adding}>{adding ? "Cancel" : "+ Add folder"}</button></div>
  {#each folders as folder (folder.path)}<div class="folder"><code>{folder.path}</code><span>Read only</span><button disabled={busy} aria-label={`Remove ${folder.path}`} onclick={() => void save(folders.filter(f => f.path !== folder.path))}>Remove</button></div>{/each}
  {#if !folders.length}<p class="hint">No folders authorized. (Pilot can still access the vault.)</p>{/if}
  {#if removed.length}
    <div class="folder-heading"><span>Removed</span><button disabled={busy} onclick={() => void save()}>Dismiss</button></div>
    <p class="hint">Pilot no longer reads these folders.</p>
    {#each removed as folder (folder.path)}<div class="folder"><code>{folder.path}</code><span class="reason">{folder.reason}</span></div>{/each}
  {/if}
  {#if adding}<form onsubmit={e => { e.preventDefault(); add(); }}><label>Folder path<input placeholder="~/Documents/Research" bind:value={path} /></label><button disabled={busy} class="save" type="submit">Authorize folder</button></form>{/if}
  {#if notice}<p role={error ? "alert" : "status"} class="notice">{notice}</p>{/if}
</section>
<style>
  .access-settings { display:flex; flex-direction:column; gap:13px; max-width:680px; margin-top:var(--sp-4); } h3 { font:var(--type-body); font-weight:600; color:var(--text-strong); margin:0; } p { font:var(--type-body); color:var(--text-note); margin:0; } .hint { font:var(--type-meta); color:var(--text-muted); }
  .folder-heading { display:flex; justify-content:space-between; align-items:center; font:var(--type-eyebrow); text-transform:uppercase; letter-spacing:1px; margin-top:8px; } button { font:var(--type-meta); color:var(--text-strong); background:none; border:0; cursor:pointer; padding:7px 0; } .folder { display:flex; flex-wrap:wrap; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid var(--rule); } code { margin-right:auto; font:var(--type-meta); font-family:var(--font-mono); overflow-wrap:anywhere; } input { font:var(--type-body); color:var(--fg); background:var(--well); border:1px solid var(--rule); padding:8px; border-radius:var(--r-sm); min-width:0; } form { display:flex; flex-wrap:wrap; gap:13px; align-items:end; } label { display:grid; gap:5px; font:var(--type-meta); } .save { background:var(--fg); color:var(--bg); padding:9px 12px; border-radius:var(--r-sm); } .notice { font:var(--type-meta); color:var(--activity); } .reason { flex-basis:100%; font:var(--type-meta); color:var(--text-muted); } button:focus-visible { outline:2px solid var(--activity); outline-offset:3px; }
</style>
