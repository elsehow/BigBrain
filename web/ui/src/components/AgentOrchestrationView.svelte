<script lang="ts">
  import { onMount } from 'svelte';
  import type { Project } from '../../../../lib/worker/projects';
  import { environmentRequest } from '../lib/projectEnvironments';
  import SettingsPage from './SettingsPage.svelte';
  import ProjectEnvironmentForm from './ProjectEnvironmentForm.svelte';
  let projects = $state<Project[]>([]), editing = $state<Partial<Project> | null>(null), error = $state(''), busy = $state(false);
  async function load() { try { projects=(await environmentRequest()).projects; } catch(e) {error=String(e);} }
  async function save(value:Record<string,unknown>) { await environmentRequest('/save',value);editing=null;await load(); }
  async function remove(project:Project) { busy=true;error='';try {await environmentRequest('/remove',{id:project.id});await load();}catch(e){error=String(e);}finally{busy=false;} }
  onMount(()=>{void load();});
</script>
<SettingsPage active="agentOrchestration" title="CONNECTED AGENTS">
  <div class="settings-list projects">
    <h2>Project environments</h2>
    <p>Set up a workspace once. Agents reuse its tools, network access, and connected credentials for future tasks. Each editing agent gets its own checkout of a Git project.</p>
    <button class="settings-add" onclick={()=>editing={}}>New environment +</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if editing}{#key editing}<ProjectEnvironmentForm project={editing} onsave={save} oncancel={()=>editing=null} />{/key}{/if}
    {#each projects as project (project.id)}
      <article class="settings-row settings-card"><div class="settings-card-main"><h2 class="settings-card-name">{project.label}</h2><span class="settings-card-about">{project.path}</span><p>{project.mode==='work'?'Development':'Read files'} · {project.network==='public'?'Public internet':project.domains.join(', ')||'Network off'}</p><p>Credentials: {project.credentials?.join(', ')||'None'} · Model: {project.model?.model||'Pilot default'}</p></div><div class="actions"><button disabled={busy} onclick={()=>editing=project}>Edit environment</button><button disabled={busy} onclick={()=>remove(project)}>Delete environment</button></div></article>
    {:else}<p>No environments yet. Your first project task will offer setup here or in its task card.</p>{/each}
  </div>
</SettingsPage>
<style>
  .projects {max-width:52rem;} h2,p {margin:0;} p {color:var(--text-muted);overflow-wrap:anywhere;} .actions {align-items:center;align-self:center;display:flex;gap:var(--sp-2);flex-wrap:wrap;} article {display:flex;justify-content:space-between;gap:var(--sp-3);flex-wrap:wrap;} button {font:var(--type-meta);color:var(--text);background:transparent;border:1px solid var(--rule);padding:var(--sp-2) var(--sp-3);cursor:pointer;} [role=alert] {color:var(--accent-2);}
</style>
