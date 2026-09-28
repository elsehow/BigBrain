<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Project, ProjectGrant } from '../../../../lib/worker/projects';
  import { DEFAULT_PILOT_BACKEND } from '../../../../lib/pilotBackendTypes';
  import { modelsForRole } from '../../../../lib/modelSelection';
  import type { ModelAgent, ModelChoice } from '../lib/modelSettings';
  import { vaultFetch } from '../lib/vaultScope';
  import { environmentRequest } from '../lib/projectEnvironments';
  import ModelControls from './ModelControls.svelte';
  let { project, submitLabel = 'Save environment', taskSetup = false, chooseModel = true, onsave, oncancel }: {
    project?: Partial<Project>; submitLabel?: string; taskSetup?: boolean; chooseModel?: boolean; onsave: (value: Record<string, unknown>, remember: boolean) => Promise<void>; oncancel: () => void;
  } = $props();
  const initial = untrack(() => project);
  let label = $state(initial?.label ?? ''), path = $state(initial?.path ?? ''), mode = $state<'read'|'work'>(initial?.mode ?? 'work');
  let network = $state(initial?.network ?? (initial?.id ? (initial.domains?.length ? 'domains' : 'off') : 'public'));
  let domains = $state(initial?.domains?.join('\n') ?? ''), references = $state(initial?.references?.join('\n') ?? '');
  let credentials = $state<string[]>(initial?.credentials ?? []), credential = $state(''), secret = $state('');
  let accounts = $state<ProjectGrant['accounts']>([]), selectedAccounts = $state<string[]>(initial?.accounts?.map(a => JSON.stringify(a)) ?? []);
  let choice = $state<ModelChoice>(initial?.model ?? DEFAULT_PILOT_BACKEND), inherit = $state(!initial?.model), models = $state<ModelAgent[]>([]);
  let busy = $state(false), error = $state(''), inspection = $state<{path:string;workspace:string;tools:{name:string;available:boolean}[];credentials:string[]} | null>(null);
  let modelError = $state('');
  const lines = (s:string) => s.split('\n').map(v=>v.trim()).filter(Boolean);
  async function inspect() { inspection = await environmentRequest('/inspect', {path}); }
  onMount(() => {
    void environmentRequest().then(v=>{accounts=v.accounts;}).catch(e=>{error=String(e);});
    void vaultFetch('/api/pilot/chat/models').then(async r=>{ if (!r.ok) throw Error('Could not load models.'); models=modelsForRole((await r.json()).agents,'pilot'); }).catch(e=>{modelError=String(e);});
    if(path) void inspect().catch(e=>{error=String(e);});
  });
  async function check() { busy=true; error=''; try { await inspect(); } catch(e) { error=String(e); } finally { busy=false; } }
  async function connect() {
    busy=true; error='';
    try { await inspect(); await environmentRequest('/credentials',{path,values:{[credential.trim()]:secret}}); credentials=[...new Set([...credentials,credential.trim()])]; credential='';secret='';await inspect(); }
    catch(e) { error=String(e); } finally { busy=false; }
  }
  async function disconnect(name:string) {
    busy=true; error=''; try { await environmentRequest('/credentials',{path,values:{[name]:null}});credentials=credentials.filter(n=>n!==name);await inspect(); } catch(e) {error=String(e);} finally {busy=false;}
  }
  async function save(remember = true) {
    busy=true; error='';
    try {
      await inspect();
      if (chooseModel && !inherit && !models.some(p=>p.ready && p.id===`pi/${choice.provider}` && p.models.some(m=>m.id===choice.model))) throw Error('Choose an available connected model.');
      await onsave({...(initial?.id?{id:initial.id}:{}),label,path,mode,references:lines(references),domains:network==='domains'?lines(domains):[],...(network==='public'?{network:'public'}:{}),credentials,accounts:selectedAccounts.map(a=>JSON.parse(a)),...(!inherit?{model:choice}:{})},remember);
      secret='';
    } catch(e) {error=String(e);} finally {busy=false;}
  }
</script>
<form aria-label="Project environment setup" onsubmit={e=>{e.preventDefault();void save();}}>
  <h3>Project environment</h3>
  <label>Project name<input bind:value={label} required maxlength="100" /></label>
  <label>Project folder<input bind:value={path} required readonly={!!initial?.path} placeholder="/Users/you/Projects/example" /></label>
  <button type="button" disabled={busy || !path} onclick={check}>Check setup</button>
  {#if inspection && inspection.path===path}
    <div role="status"><p>{inspection.workspace==='checkout' ? 'Git repository · each editing agent gets an independent checkout of committed HEAD.' : 'Non-Git folder · edits apply directly to this folder.'}</p>
    <p>Available tools: {inspection.tools.filter(t=>t.available).map(t=>t.name).join(', ') || 'None detected'}</p>
    {#if inspection.tools.some(t=>!t.available)}<p>Not installed: {inspection.tools.filter(t=>!t.available).map(t=>t.name).join(', ')}. Only needed if your task uses them.</p>{/if}</div>
  {/if}
  <label>Workspace access<select aria-label="Workspace access" bind:value={mode}><option value="work">Development · edits and commands</option><option value="read">Read files and propose changes</option></select></label>
  {#if mode==='read'}<p>Read mode cannot run tools such as GitHub CLI or tests. Choose Development for tasks that use commands.</p>{/if}
  <label>Network<select aria-label="Network" bind:value={network}><option value="public">Public internet</option><option value="domains">Selected domains</option><option value="off">Off</option></select></label>
  <p>{network==='public' ? 'Commands may send data to public internet services. Local and private networks remain blocked.' : 'Network access does not connect an account or authorize publishing.'}</p>
  {#if network==='domains'}<label>Allowed domains<textarea bind:value={domains} placeholder="One exact domain per line"></textarea></label>{/if}
  <details><summary>Reference folders (optional)</summary><label>Read-only reference folders<textarea bind:value={references} placeholder="Optional; one absolute folder per line"></textarea></label></details>
  <details><summary>Connected credentials{credentials.length ? ` (${credentials.length})` : ' (optional)'}</summary><fieldset><legend>Command credentials</legend>
    <p>Tokens are shared with this project's commands. Use the name expected by the tool, such as GH_TOKEN or NPM_TOKEN. The token's account permissions apply.</p>
    {#each inspection?.credentials ?? [] as name}<div class="credential"><label class="check"><input type="checkbox" bind:group={credentials} value={name} />{name}</label><button type="button" disabled={busy} onclick={()=>disconnect(name)}>Disconnect</button></div>{/each}
    <label>Variable name<input bind:value={credential} placeholder="GH_TOKEN" autocomplete="off" /></label>
    <label>Token<input type="password" bind:value={secret} autocomplete="new-password" /></label>
    <button type="button" disabled={busy || !path || !credential.trim() || !secret} onclick={connect}>Connect credential</button>
    <p>Saved immediately. Disconnect stops agents using this credential.</p>
  </fieldset></details>
  {#if accounts.length}<fieldset><legend>Live source accounts (read only)</legend>{#each accounts as account}<label class="check"><input type="checkbox" bind:group={selectedAccounts} value={JSON.stringify(account)} />{account.integration}: {account.account}</label>{/each}</fieldset>{/if}
  {#if chooseModel}<label class="check"><input type="checkbox" bind:checked={inherit} />Use the launching Pilot's model by default</label>
  {#if !inherit}<ModelControls label="Agent" agents={models} value={choice} disabled={busy} deferred save={async next=>{choice=next;}} />{/if}
  {/if}
  {#if modelError}<p role="alert">{modelError}</p>{/if}
  <p>Access is reusable. Sending messages, publishing changes, and deploying still require instructions for the task.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="actions"><button type="submit" disabled={busy || !label.trim() || !path}>{busy?'Checking…':submitLabel}</button><button type="button" disabled={busy} onclick={oncancel}>Cancel</button>{#if taskSetup}<button type="button" disabled={busy || !label.trim() || !path} onclick={()=>save(false)}>Allow for this task</button>{/if}</div>
</form>
<style>
  summary {cursor:pointer;padding:var(--sp-2) 0;} form, label, fieldset { display:flex; flex-direction:column; gap:var(--sp-2); } form { gap:var(--sp-3); padding:var(--sp-4); border:1px solid var(--rule); } h3,p {margin:0;} p {color:var(--text-muted);font:var(--type-meta);} input,textarea,select {font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--rule);padding:var(--sp-2);min-width:0;} textarea {min-height:3rem;} .check,.actions,.credential {display:flex;flex-direction:row;align-items:center;gap:var(--sp-2);flex-wrap:wrap;} button {font:var(--type-meta);color:var(--text);background:transparent;border:1px solid var(--rule);padding:var(--sp-2) var(--sp-3);cursor:pointer;} button:disabled {opacity:.5;} fieldset {min-width:0;border:1px solid var(--rule);} [role=alert] {color:var(--accent-2);}
</style>
