<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { onMount } from 'svelte';
  let { onBusy }: { onBusy?:(busy:boolean)=>void }=$props();
  type Client={kind:string;name:string;available:boolean;connected:boolean};
  let clients=$state<Client[]>([]),busy=$state(''),error=$state('');
  async function request(body?:unknown){const r=await fetch('/api/connected-clients',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const v=await r.json();if(!r.ok)throw Error(v.error||'Could not configure clients.');clients=v.local??[];}
  async function change(client:Client,enabled:boolean){const prior=client.connected;client.connected=enabled;busy=client.kind;onBusy?.(true);error='';try{await request({action:'local',kind:client.kind,enabled});}catch(e){client.connected=prior;error=e instanceof Error?e.message:'Could not configure client.';}finally{busy='';onBusy?.(false);}}
  onMount(()=>{void request().catch(e=>error=e.message);});
</script>
<div class="clients">
  {#each clients as client}<label class:unavailable={!client.available}><input type="checkbox" checked={client.connected} disabled={!!busy||!client.available} onchange={e=>change(client,e.currentTarget.checked)}/><span>{client.name}</span><small>{busy===client.kind?'Connecting…':client.connected?'Access enabled':client.available?'Ready to connect':'Not installed'}</small></label>{/each}
  {#if error}<p role="alert">{error}<button onclick={()=>request().catch(e=>error=e.message)}>Retry</button></p>{/if}
</div>
<style>
.clients{display:grid}label{display:flex;align-items:center;gap:16px;padding:22px 0;border-bottom:1px solid var(--rule);font:var(--type-body);cursor:pointer}input{width:18px;height:18px;accent-color:var(--text-strong)}small{margin-left:auto;font:var(--type-meta);color:var(--text-muted)}.unavailable{opacity:.55}p{font:var(--type-meta);color:var(--err)}button{font:inherit;background:transparent;color:var(--text);border:1px solid var(--rule);padding:8px;margin-left:12px}
</style>
