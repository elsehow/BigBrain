<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { providerLabel } from "../../../../lib/providerPresentation";
  import { onMount } from "svelte";
  let { runner }: { runner?: string } = $props();
  let adding = $state(false), configuring = $state<string | null>(null);
  const label = (kind: string) => kind === "codex" || kind === "claude-code" ? providerLabel(kind) : "MCP client";
  const status = (c: {revoked:string|null;expired?:boolean}) => c.revoked ? 'Access revoked' : c.expired ? 'Expired after 30 days unused' : 'Authorized';
  type Client={id:string;name:string;kind:string;managedBy?:string;legacy?:boolean;replaces?:string;lastUsed:string|null;revoked:string|null;expired?:boolean};
  let clients=$state<Client[]>([]), name=$state(""),kind=$state("claude-code"),busy=$state(false),error=$state("");
  type Setup={id:string;command:string|null;configuration:unknown;instructions:string};
  let setups=$state<Record<string,Setup>>({}), showingSetup=$state<string|null>(null), copied=$state<string|null>(null);
  async function request(body?:unknown){const r=await fetch('/api/connected-clients',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const v=await r.json();if(!r.ok)throw Error(v.error||'Could not load clients.');return v;}
  async function load(){
    const waiting=clients.filter(c=>!c.lastUsed).map(c=>c.id);
    clients=(await request()).clients;
    if(showingSetup && waiting.includes(showingSetup) && clients.find(c=>c.id===showingSetup)?.lastUsed)showingSetup=null;
  }
  async function action(body:unknown){busy=true;error='';try{const r=await request(body);if((body as {action:string}).action!=='setup')configuring=null;if(r.configuration&&!runner){setups[r.id]=r;showingSetup=r.id;adding=false;}await load();}catch(e){error=e instanceof Error?e.message:'Client setup failed.';}finally{busy=false;}}
  async function configure(id:string){
    if(configuring===id){configuring=null;showingSetup=null;return;}
    configuring=id;showingSetup=null;copied=null;
    if(!runner && !clients.find(c=>c.id===id)?.legacy)await action({action:'setup',id});
  }
  async function copy(setup:Setup){
    error='';copied=null;
    const text=setup.command??JSON.stringify(setup.configuration,null,2);
    try { await navigator.clipboard.writeText(text);copied=setup.id; }
    catch {
      const field=document.createElement('textarea');field.value=text;field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);field.select();
      try { if(!document.execCommand('copy'))throw Error();copied=setup.id; }
      catch { error='Could not copy. Select the setup text to copy it.'; }
      finally { field.remove(); }
    }
  }
  onMount(()=>{const refresh=()=>{if(!busy)void load().catch(e=>error=e.message);};refresh();const timer=setInterval(refresh,5000);return()=>clearInterval(timer);});
</script>

  <section class="settings-list" aria-label="Connected Clients">
    {#if !runner}
    <button class="settings-add" onclick={() => adding = !adding} aria-expanded={adding}>{adding ? 'Cancel' : 'New connection +'}</button>
    {#if adding}
    <form onsubmit={e=>{e.preventDefault();void action({action:'create',name:name.trim() || label(kind),kind});}}>
      <label>Client<select bind:value={kind} disabled={busy}><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="generic">Generic MCP client</option></select></label>
      <label>Connection name<input bind:value={name} maxlength="120" placeholder={label(kind)} disabled={busy}/></label>
      <button disabled={busy}>Create connection</button>
    </form>{/if}
    <h3>Existing connections</h3>
    <p>Each entry grants separate access to your vault. Status shows permission to access it; last use records activity. A connection unused for 30 days expires; renewing it keeps its setup and access.</p>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}

    {#each clients.filter(c => !(c.legacy && c.revoked) && (runner ? c.managedBy === 'runner:'+runner : !c.managedBy?.startsWith('runner:'))) as client(client.id)}
    {#if runner}
    <!-- Under an agent's Vault access section the heading is the section label; this is a line, not a card. -->
    <div class="settings-row compact">
      <div class="settings-status-row">
        <span class="settings-item-name">MCP connection</span>
        <span class="settings-status"><i class:ready={!client.revoked && !client.expired} aria-hidden="true"></i>{status(client)}</span>
        {#if client.revoked}<button disabled={busy} onclick={()=>action({action:"reconnect",id:client.id})}>Reconnect</button>
        {:else if client.expired}<button disabled={busy} onclick={()=>action({action:"renew",id:client.id})}>Renew</button>
        {:else}<button aria-expanded={configuring === client.id} aria-controls={'client-'+client.id} onclick={()=>configure(client.id)}>{configuring === client.id ? 'Done' : 'Configure'}</button>{/if}
      </div>
      {#if !client.revoked && configuring === client.id}
        <div class="client-controls" id={'client-'+client.id}>
          {#if client.lastUsed}<p>Last used {new Date(client.lastUsed).toLocaleString()}</p>{/if}
          <div class="actions"><button disabled={busy} onclick={()=>action({action:'revoke',id:client.id})}>Disconnect</button></div>
        </div>
      {/if}
    </div>
    {:else}
    <div class="settings-row settings-card">
      <div class="settings-card-row">
        <div class="settings-card-main">
          <h2 class="settings-card-name">{client.name}</h2>
          <span class="settings-card-about">{client.legacy ? 'Legacy plugin connection, deprecated. Replace it with a named MCP connection.' : `${label(client.kind)}, reaching your vault through BigBrain’s MCP server with this connection’s access.`}</span>
          <span class="settings-status"><i class:ready={!client.revoked && !client.expired} aria-hidden="true"></i>{status(client)}</span>
          <span class="settings-item-note">Connection {client.id} · {client.legacy ? 'Legacy plugin' : client.replaces ? 'Legacy plugin replacement' : client.managedBy?.startsWith('local:') ? 'Set up on this computer' : 'Manual setup'}</span>
          <span class="settings-item-note">{client.lastUsed ? `Last used ${new Date(client.lastUsed).toLocaleString()}` : 'Not used yet'}</span>
        </div>
        {#if client.revoked && !client.legacy}<button disabled={busy} onclick={()=>action({action:"reconnect",id:client.id})}>Reconnect</button>
        {:else if client.expired}<div class="actions"><button disabled={busy} onclick={()=>action({action:"renew",id:client.id})}>Renew</button><button aria-expanded={configuring === client.id} aria-controls={'client-'+client.id} onclick={()=>configure(client.id)}>{configuring === client.id ? 'Done' : 'Configure'}</button></div>
        {:else if !client.revoked}<button aria-expanded={configuring === client.id} aria-controls={'client-'+client.id} onclick={()=>configure(client.id)}>{configuring === client.id ? 'Done' : 'Configure'}</button>{/if}
      </div>
      {#if client.legacy}
        <div class="settings-card-body" id={'client-'+client.id}><div class="settings-group"><span class="settings-group-label">Legacy plugin</span><div class="settings-group-body">
          {#if !client.revoked}
            <p>{client.expired ? 'Renew it, or replace it with a named MCP connection.' : 'Replace this with a named MCP connection. The plugin keeps working until the replacement connects.'}</p>
            <button disabled={busy} onclick={()=>action({action:'replace',id:client.id})}>Replace connection</button>
          {:else}
            <p>Remove the old BigBrain plugin from your client's installed plugins, then restart the client.</p>
          {/if}
        </div></div>
        {#if !client.revoked && configuring === client.id}
          <div class="settings-group"><span class="settings-group-label">Connection</span><div class="settings-group-body">
            {#if client.lastUsed}<p>Last used {new Date(client.lastUsed).toLocaleString()}.</p>{/if}
            <button disabled={busy} onclick={()=>action({action:'revoke',id:client.id})}>Disconnect</button>
          </div></div>
        {/if}
        </div>
      {:else if !client.revoked && ((setups[client.id] && showingSetup === client.id) || configuring === client.id)}
        <div class="settings-card-body" id={'client-'+client.id}>
          {#if setups[client.id] && showingSetup === client.id}
            {@const setup=setups[client.id]}
            <div class="settings-group"><span class="settings-group-label">Setup</span><div class="settings-group-body">
              <section class="setup" aria-label="Client setup">
                <p>{setup.instructions}</p>
                <div class="command-block"><pre><code>{setup.command??JSON.stringify(setup.configuration,null,2)}</code></pre><button onclick={()=>copy(setup)}>{copied===client.id?'Copied':'Copy setup'}</button></div>
                <button onclick={()=>showingSetup=null}>Hide setup</button>
              </section>
            </div></div>
          {/if}
          {#if configuring === client.id}
            <div class="settings-group"><span class="settings-group-label">Connection</span><div class="settings-group-body">
              <p>{client.lastUsed ? `Last used ${new Date(client.lastUsed).toLocaleString()}.` : 'Not used yet. Run the setup command in the client, then restart its MCP connection.'}</p>
              <div class="actions">{#if showingSetup !== client.id}<button disabled={busy} onclick={()=>action({action:'setup',id:client.id})}>Setup</button>{/if}<button disabled={busy} onclick={()=>action({action:'revoke',id:client.id})}>Disconnect</button></div>
            </div></div>
          {/if}
        </div>
      {/if}
    </div>
    {/if}
    {:else}{#if !runner}<p>No connections yet.</p>{/if}{/each}
  </section>

<style>
  .command-block{background:var(--well);border:1px solid var(--rule);padding:16px;display:grid;gap:12px;min-width:0}.command-block pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6}
  .client-controls{display:grid;gap:16px;margin-top:16px}
  .settings-row.compact{padding:0;border-bottom:0}
  section,form{display:grid;gap:16px;min-width:0}h3,p{margin:0}h3{font:var(--type-body);font-weight:500}p,label{font:var(--type-body)}p{color:var(--text-muted)}form,.setup{padding:12px 0;border-bottom:1px solid var(--rule)}.setup{padding:0;border-bottom:0}label{display:grid;gap:8px}input,select{padding:10px;font:inherit;background:var(--well);color:var(--text);border:1px solid var(--rule);max-width:100%;box-sizing:border-box}button{justify-self:start;font:var(--type-body);padding:8px 12px;border:1px solid var(--rule);background:transparent;color:var(--text-strong);cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--activity);outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font:var(--type-meta)}[role=alert]{color:var(--err)}
</style>
