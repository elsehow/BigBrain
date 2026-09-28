<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { onMount } from 'svelte';
  import '../lib/settingsLists.css';
  import IntegrationAccountSettings from './IntegrationAccountSettings.svelte';
  import BrowserPair from './BrowserPair.svelte';
  type Entry={id:string;name:string;description:string;added:boolean};
  let entries=$state<Entry[]>([]),editing=$state(''),busy=$state(''),error=$state('');
  async function request(body?:unknown){const r=await fetch('/api/integration-accounts',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const v=await r.json();if(!r.ok)throw Error(v.error||'Could not load integrations.');entries=v.library??[];}
  async function add(id:string){busy=id;error='';try{await request({name:id,action:'install'});editing=id;}catch(e){error=e instanceof Error?e.message:'Could not add integration.';}finally{busy='';}}
  onMount(()=>{void request().catch(e=>error=e.message);});
</script>
<div class="integration-library settings">
  {#if error}<p role="alert">{error}<button onclick={()=>request().catch(e=>error=e.message)}>Retry</button></p>{/if}
  {#if entries.some(i=>i.added)}<section aria-label="Your integrations"><h2>Your integrations</h2>
    {#each entries.filter(i=>i.added) as entry}<div class="installed"><div class="row"><h3>{entry.name}</h3><button aria-expanded={editing===entry.id} onclick={()=>editing=editing===entry.id?'':entry.id}>{editing===entry.id?'Done':'Configure'}</button></div>
      {#if editing===entry.id}<div class="configuration">{#if entry.id==='browser'}<BrowserPair />{:else}<IntegrationAccountSettings source={entry.id} openFirst />{/if}</div>{/if}
    </div>{/each}
  </section>{/if}
  <section aria-label="Integration library"><h2>Library</h2><div class="library">
    {#each entries as entry}<article><h3>{entry.name}</h3><p>{entry.description}</p><button disabled={!!busy||entry.added} onclick={()=>add(entry.id)}>{entry.added?'✓ Added':busy===entry.id?'Adding…':'+ Add'}</button></article>{/each}
  </div></section>
</div>
<style>
.integration-library{display:grid;gap:30px}h2{font:var(--type-body);font-weight:500;margin:0 0 14px}h3{font:var(--type-body);font-weight:500;margin:0}p{font:var(--type-meta);color:var(--text-muted);line-height:1.5;margin:0}button{font:var(--type-body);border:1px solid var(--rule);background:transparent;color:var(--text-strong);padding:10px 16px;border-radius:6px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid var(--activity);outline-offset:3px}.library{display:grid;grid-template-columns:1fr 1fr;gap:16px}article{border:1px solid var(--rule);border-radius:10px;padding:24px;display:grid;gap:18px}article button{justify-self:start}.installed{border:1px solid var(--rule);border-radius:8px;margin-bottom:12px;overflow:hidden}.row{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;gap:16px}.configuration{padding:20px;border-top:1px solid var(--rule)}[role=alert]{color:var(--err)}@media(max-width:600px){.library{grid-template-columns:1fr}}
</style>
