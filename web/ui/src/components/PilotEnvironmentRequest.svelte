<script lang="ts">
  import { gotoNote } from '../lib/store.svelte';
  import { sessionPath } from "../../../../lib/workSessionIdentity";
  import { onMount } from 'svelte';
  import type { WorkDetail } from '../../../../lib/workViews';
  import { workRequest, refreshWork } from '../lib/workSessions.svelte';
  import { environmentRequest } from '../lib/projectEnvironments';
  import { loadChatDetail } from '../lib/pilotChat.svelte';
  import { refreshNotifications } from '../lib/notifications.svelte';
  import { subscribeApplication } from '../lib/applicationUpdates';
  let { requestKey, pilotId, unread = false }: { requestKey: string; pilotId: string; unread?: boolean } = $props();
  const agent = $derived(requestKey.split(':')[0]!);
  let job = $state<WorkDetail | null>(null), error = $state(''), busy = $state(false), done = $state(false);
  let connected = $state<string[]>([]), tokens = $state<Record<string,string>>({});
  let workspace = $state('');
  let inspected = $state(false), remember = $state(true);
  const request = $derived(job?.worker?.request);
  const pending = $derived(request?.kind==='access' && `${agent}:${request.id}`===requestKey ? request : null);
  const missing = $derived((pending?.grant.credentials ?? []).filter(n=>!connected.includes(n)));
  onMount(()=>{
    let stopped=false;
    const load=async()=>{
      try {
        const next=await workRequest<WorkDetail>(`?id=${encodeURIComponent(agent)}`);
        if(stopped)return; job=next;
        if(next.worker?.request?.kind==='access') {
          const info=await environmentRequest('/inspect',{path:next.worker.request.grant.path});
          if(stopped)return; connected=info.credentials;workspace=info.workspace;inspected=true;
        }
      } catch(e) {if(!stopped)error=e instanceof Error?e.message:'Could not load the access request.';}
    };
    void load();
    const unsubscribe=subscribeApplication(update=>{if(update.snapshot || update.entities.some(e=>e.kind==='work' && e.id===agent))void load();});
    const timer=setInterval(()=>{if(!busy)void load();},2000);
    return()=>{stopped=true;clearInterval(timer);unsubscribe();};
  });
  async function connect(name:string) {
    if(!pending || busy)return;busy=true;error='';
    try {const result=await environmentRequest('/credentials',{path:pending.grant.path,values:{[name]:tokens[name]}});connected=result.names;tokens[name]='';}
    catch(e){error=e instanceof Error?e.message:'Could not connect the credential.';}finally{busy=false;}
  }
  async function decide(allow:boolean) {
    if(!pending || busy)return;busy=true;error='';
    try {
      await workRequest('/approve',{id:agent,request:pending.id,allow,remember:allow&&remember});done=true;tokens={};
      await Promise.all([refreshWork(),refreshNotifications(),loadChatDetail(pilotId)]);
    } catch(e){error=e instanceof Error?e.message:'Could not answer this request.';}finally{busy=false;}
  }
</script>
{#if pending && !done}
  <section class="environment-approval" aria-label="Project environment approval">
    <div class="heading"><h3>{#if unread}<span class="unread-dot" role="img" aria-label="Unread"></span>{/if}{pending.initial?'Set up':'Update'} {pending.label ?? 'project access'}</h3><span class="pending-status">Needs approval</span></div>
    <dl>
      <dt>Workspace</dt><dd>{pending.grant.path}</dd>
      <dt>Workspace type</dt><dd>{workspace==='checkout' && pending.grant.mode==='work'?'Separate Git checkout':pending.grant.mode==='read'?'Read-only folder':'Direct folder access'}</dd>
      <dt>Access</dt><dd>{pending.grant.mode==='work'?'Edits and commands':'Read files only'}</dd>
      <dt>Network</dt><dd>{pending.grant.network==='public'?'Public internet':pending.grant.domains.join(', ')||'Off'}</dd>
      {#if pending.grant.references.length}<dt>Read-only folders</dt><dd>{pending.grant.references.join(', ')}</dd>{/if}
      {#if pending.grant.accounts.length}<dt>Accounts</dt><dd>{pending.grant.accounts.map(a=>`${a.integration}: ${a.account}`).join(', ')}</dd>{/if}
      <dt>Credentials</dt><dd>{pending.grant.credentials?.join(', ')||'None needed'}</dd>
      <dt>Model</dt><dd>{job?.model}</dd>
    </dl>
    {#each missing as name}
      <form onsubmit={e=>{e.preventDefault();void connect(name);}}>
        <label>Connect {name}<input type="password" aria-label={`Token for ${name}`} bind:value={tokens[name]} autocomplete="new-password" placeholder="Token" /></label>
        <button disabled={busy || !tokens[name]} type="submit">Connect {name}</button>
      </form>
    {/each}
    {#if missing.length}<p>Connect the requested token here. It is saved locally for this project, not posted to the conversation.</p>{/if}
    <p>Tell Pilot what to change, or allow this setup.</p>
    <label class="remember"><input type="checkbox" bind:checked={remember} />Remember for this project</label>
    <div class="actions">
      <button class="primary" disabled={busy || !inspected || !!missing.length} onclick={()=>decide(true)}>{pending.initial?'Allow and launch':'Allow and resume'}</button>
      <button disabled={busy} onclick={()=>decide(false)}>Decline</button>
      <a href={`#/session/${agent}`} onclick={e=>{if(!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey){e.preventDefault();gotoNote(sessionPath(agent));}}}>Advanced settings</a>
    </div>
  </section>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
<style>
  .environment-approval { display:flex; flex-direction:column; gap:var(--sp-3); margin-top:var(--sp-3); font:var(--type-body); }
  h3,p { margin:0; }
  .heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--sp-2); }
  h3 { display:flex; align-items:center; gap:var(--sp-2); font:inherit; font-weight:600; }
  .unread-dot { width:7px; height:7px; border-radius:50%; background:var(--activity); flex:none; }
  .pending-status { font:var(--type-meta); color:var(--text-muted); }
  .actions a { color:inherit; font:var(--type-meta); text-decoration:underline; text-underline-offset:3px; padding:var(--sp-2); }
  button.primary,button.primary:hover:not(:disabled) { color:var(--bg); background:var(--fg); border-color:var(--fg); }

  p { font:var(--type-meta); }
  dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--sp-2) var(--sp-3); margin:0; font:var(--type-meta); }
  dd { margin:0; overflow-wrap:anywhere; }
  .actions,form,.remember { display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap; }
  label { display:grid; gap:var(--sp-2); font:var(--type-meta); }
  input,button { color:inherit; background:transparent; border:1px solid currentColor; }
  input { font:inherit; padding:var(--sp-2); min-width:0; }
  input::placeholder { color:inherit; opacity:.7; }
  input[type=checkbox] { accent-color:currentColor; }
  button { font:var(--type-meta); padding:var(--sp-2) var(--sp-3); cursor:pointer; }
  button:hover:not(:disabled) { background:color-mix(in srgb, currentColor 10%, transparent); }
  button:disabled { opacity:.5; cursor:default; }
  button:focus-visible,input:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
  .error { color:inherit; }
</style>
